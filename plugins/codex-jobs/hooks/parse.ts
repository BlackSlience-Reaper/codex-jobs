// What this mod reads out of plain text: a Bash command, Codex's output, a
// background task's notification. No engine calls here.

export type CodexCommand = {
  subcommand: string
  prompt?: string
  model?: string
  /** The shell itself backgrounds it (`&`), so the Bash call ends first. */
  isDetached: boolean
}

export type CodexOutput = {
  tokens?: number
  model?: string
  toolCalls?: number
  activity: string[]
  outcome?: string
  error?: string
}

export type TaskNotification = {
  taskId?: string
  toolUseId?: string
  status?: string
  outputFile?: string
  summary?: string
}

type Segment = { words: string[]; isPiped: boolean; isDetached: boolean }

const REDIRECT = /^\d*(>>?|<<?-?|&>)/
const REDIRECT_ALONE = /^\d*(>>?|<<?-?|&>)$/

const PREFIXES = new Set([
  'nohup',
  'time',
  'command',
  'builtin',
  'exec',
  'env',
  'caffeinate',
  'stdbuf',
  'nice',
  'timeout',
  'gtimeout',
  'npx',
  'bunx',
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])

const FLAGS_WITH_VALUE = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-C',
  '--cd',
  '--add-dir',
  '--thread-source',
  '--cyber-access-program',
  '--output-schema',
  '--color',
  '-o',
  '--output-last-message',
  '--base',
  '--commit',
  '--title',
  '--env',
  '--remote',
  '--remote-auth-token-env',
])

/** Subcommands that manage Codex rather than give it work. */
const NOT_JOBS = new Set([
  'help',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'plugin',
  'agents',
  'app',
  'app-server',
  'remote-control',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'unarchive',
  'migrate-rollouts',
  'exec-server',
  'features',
])

const stripHeredocs = (command: string): { text: string; bodies: string[] } => {
  const lines = command.split('\n')
  const kept: string[] = []
  const bodies: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    kept.push(line)
    const opener = /<<-?\s*['"]?([A-Za-z_]\w*)['"]?/.exec(line)
    if (!opener) continue
    const body: string[] = []
    i++
    while (i < lines.length && (lines[i] ?? '').trim() !== opener[1]) {
      body.push(lines[i] ?? '')
      i++
    }
    bodies.push(body.join('\n'))
  }

  return { text: kept.join('\n'), bodies }
}

const splitSegments = (command: string): Segment[] => {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: string | undefined
  let depth = 0
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = (isPiped = false, isDetached = false) => {
    endWord()
    if (words.length > 0) segments.push({ words, isPiped, isDetached })
    words = []
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    const after = command[i + 1]
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && after) {
        word += after
        i++
      } else word += char
    } else if (depth > 0) {
      word += char
      if (char === '(') depth++
      if (char === ')') depth--
    } else if (char === '\\' && after) {
      if (after !== '\n') {
        word += after
        hasWord = true
      }
      i++
    } else if (char === "'" || char === '"') {
      quote = char
      hasWord = true
    } else if (char === '$' && after === '(') {
      word += '$('
      hasWord = true
      depth = 1
      i++
    } else if (char === '#' && !hasWord) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === '\n' || char === ';' || char === '(' || char === ')') {
      endSegment()
    } else if (char === '|') {
      if (after === '|') {
        i++
        endSegment()
      } else endSegment(true)
    } else if (char === '&') {
      if (after === '&') {
        i++
        endSegment()
      } else if (word.endsWith('>') || after === '>') {
        word += char
        hasWord = true
      } else endSegment(false, true)
    } else {
      word += char
      hasWord = true
    }
  }
  endSegment()

  return segments
}

const baseName = (word: string): string =>
  (word.split('/').pop() ?? word).replace(/@.*$/, '')

/** The words after `codex`, a shell's `-c` string, or nothing. */
const findCodex = (
  words: readonly string[],
): { args: string[] } | { script: string } | undefined => {
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (/^\w+=/.test(word) || word === '{') {
      i++
      continue
    }
    const name = baseName(word)
    if (name === 'codex') return { args: words.slice(i + 1) }
    if (PREFIXES.has(name)) {
      i++
      while (/^(-|\d+[smhd]?$)/.test(words[i] ?? '')) i++
      continue
    }
    if (SHELLS.has(name)) {
      const flag = words.findIndex(one => /^-\w*c$/.test(one))
      const script = flag >= 0 ? words[flag + 1] : undefined

      return script === undefined ? undefined : { script }
    }

    return undefined
  }

  return undefined
}

const readArgs = (
  args: readonly string[],
): {
  positionals: string[]
  model?: string
  isLast: boolean
  isInfo: boolean
} => {
  const positionals: string[] = []
  let model: string | undefined
  let isLast = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (REDIRECT.test(arg)) {
      if (REDIRECT_ALONE.test(arg)) i++
    } else if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    } else if (arg.startsWith('-') && arg !== '-') {
      if (['-h', '--help', '-V', '--version'].includes(arg)) {
        return { positionals, isLast, isInfo: true }
      }
      const equals = arg.indexOf('=')
      const flag = equals >= 0 ? arg.slice(0, equals) : arg
      let value = equals >= 0 ? arg.slice(equals + 1) : undefined
      if (value === undefined && FLAGS_WITH_VALUE.has(flag)) {
        i++
        value = args[i]
      }
      if (flag === '--last') isLast = true
      if (flag === '-m' || flag === '--model') model = value
      if ((flag === '-c' || flag === '--config') && value?.startsWith('model=')) {
        model ??= value.slice('model='.length).replace(/^["']|["']$/g, '')
      }
    } else positionals.push(arg)
  }

  return { positionals, model, isLast, isInfo: false }
}

const readJob = (
  positionals: readonly string[],
  isLast: boolean,
): { subcommand: string; prompt?: string } | undefined => {
  const [first, ...rest] = positionals
  if (first === undefined || NOT_JOBS.has(first)) return undefined
  const resumed = (list: readonly string[]) => (isLast ? list[0] : list[1])
  if (first === 'cloud') {
    return rest[0] === 'exec'
      ? { subcommand: 'cloud', prompt: rest[1] }
      : undefined
  }
  if (first === 'review') return { subcommand: 'review', prompt: rest[0] }
  if (first === 'resume' || first === 'fork') {
    return { subcommand: first, prompt: resumed(rest) }
  }
  if (first === 'exec' || first === 'e') {
    const [second, ...tail] = rest
    if (second === 'help') return undefined
    if (second === 'review') return { subcommand: 'review', prompt: tail[0] }
    if (second === 'resume' || second === 'fork') {
      return { subcommand: second, prompt: resumed(tail) }
    }

    return { subcommand: 'exec', prompt: second }
  }

  return { subcommand: 'run', prompt: first }
}

/** The Codex job a Bash command starts, or undefined when it starts none. */
export const parseCodexCommand = (command: string): CodexCommand | undefined => {
  const { text, bodies } = stripHeredocs(command)
  const segments = splitSegments(text)
  for (const [index, segment] of segments.entries()) {
    const found = findCodex(segment.words)
    if (!found) continue
    if ('script' in found) {
      const inner = parseCodexCommand(found.script)
      if (inner) return inner
      continue
    }
    const { positionals, model, isLast, isInfo } = readArgs(found.args)
    if (isInfo) continue
    const job = readJob(positionals, isLast)
    if (!job) continue
    let end = index
    while (segments[end]?.isPiped && segments[end + 1]) end++
    const prompt = job.prompt === '-' ? undefined : job.prompt

    return {
      subcommand: job.subcommand,
      prompt: prompt ?? bodies[0],
      model,
      isDetached: segments[end]?.isDetached ?? false,
    }
  }

  return undefined
}

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

const TOOL_ITEMS: Readonly<Record<string, string>> = {
  file_change: 'file change',
  mcp_tool_call: 'MCP tool',
  web_search: 'web search',
}

type JsonEvent = {
  type?: string
  message?: string
  error?: { message?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
  item?: {
    id?: string
    type?: string
    text?: string
    command?: string
    tool?: string
    query?: string
  }
}

const parseEvent = (line: string): JsonEvent | undefined => {
  if (!line.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(line)

    return typeof value === 'object' && value !== null
      ? (value as JsonEvent)
      : undefined
  } catch {
    return undefined
  }
}

const readEvents = (events: readonly JsonEvent[]): CodexOutput => {
  const output: CodexOutput = { activity: [] }
  const tools = new Set<string>()
  for (const event of events) {
    if (event.type === 'turn.completed' && event.usage) {
      output.tokens =
        (output.tokens ?? 0) +
        (event.usage.input_tokens ?? 0) +
        (event.usage.output_tokens ?? 0)
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      output.error = event.error?.message ?? event.message ?? output.error
    }
    const item = event.item
    if (!item || event.type !== 'item.completed') continue
    if (item.type === 'agent_message') output.outcome = item.text
    const line =
      item.type === 'command_execution'
        ? `$ ${item.command ?? ''}`
        : item.type && TOOL_ITEMS[item.type]
          ? `${TOOL_ITEMS[item.type]}${item.tool ?? item.query ? ` ${item.tool ?? item.query}` : ''}`
          : undefined
    if (line !== undefined) {
      tools.add(item.id ?? String(tools.size))
      output.activity.push(line)
    }
  }
  if (tools.size > 0) output.toolCalls = tools.size

  return output
}

/** What Codex's output says, from `--json` events or its plain log. */
export const parseOutput = (raw: string): CodexOutput => {
  const text = stripAnsi(raw).replace(/\r\n?/g, '\n').trim()
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const events = lines.map(parseEvent).filter(one => one !== undefined)
  if (events.length > 0 && events.length >= lines.length / 2) {
    return readEvents(events)
  }

  const output: CodexOutput = { activity: lines.slice(-20) }
  const used = /tokens used\s*:?\s*([\d,]+)\s*\n?([\s\S]*)$/i.exec(text)
  if (used?.[1]) output.tokens = Number(used[1].replaceAll(',', ''))
  const model = /^model:\s*(\S+)/m.exec(text)
  if (model?.[1]) output.model = model[1]
  const after = used?.[2]?.trim()
  const before = used ? text.slice(0, used.index).trim() : text
  output.outcome =
    after || before.split('\n').slice(-12).join('\n').trim() || undefined

  return output
}

const tagValue = (text: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim()

/** The fields of a `<task-notification>`, or undefined when it holds none. */
export const parseNotification = (text: string): TaskNotification | undefined => {
  const taskId = tagValue(text, 'task-id')
  const toolUseId = tagValue(text, 'tool-use-id')
  if (taskId === undefined && toolUseId === undefined) return undefined

  return {
    taskId,
    toolUseId,
    status: tagValue(text, 'status'),
    outputFile: tagValue(text, 'output-file'),
    summary: tagValue(text, 'summary'),
  }
}

/** A prompt's first readable line: tags dropped, spaces folded. */
export const headLine = (text: string): string => {
  const plain = text
    .replace(/<([\w-]+)>[\s\S]*?<\/\1>/g, ' ')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())

  return plain.find(line => line !== '') ?? ''
}

const cells = (point: number): number =>
  point >= 0x1100 &&
  (point <= 0x115f ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f300 && point <= 0x1faff) ||
    (point >= 0x20000 && point <= 0x3fffd))
    ? 2
    : 1

export const widthOf = (text: string): number => {
  let width = 0
  for (const char of text) width += cells(char.codePointAt(0) ?? 0)

  return width
}

/** Cut to `max` cells, an ellipsis standing for what was cut. */
export const clip = (text: string, max: number): string => {
  if (widthOf(text) <= max) return text
  let width = 0
  let out = ''
  for (const char of text) {
    const next = cells(char.codePointAt(0) ?? 0)
    if (width + next > max - 1) break
    out += char
    width += next
  }

  return `${out}…`
}

/** Lines of at most `max` cells; a source line break stays one. */
export const wrapLines = (text: string, max: number): string[] => {
  const room = Math.max(1, max)
  const out: string[] = []
  for (const source of text.split('\n')) {
    let width = 0
    let line = ''
    for (const char of source) {
      const next = cells(char.codePointAt(0) ?? 0)
      if (width + next > room) {
        out.push(line)
        line = ''
        width = 0
      }
      line += char
      width += next
    }
    out.push(line)
  }

  return out
}

/** `12s`, `1m 12s`, `2h 03m`; `tight` drops the space, as a header reads. */
export const formatDuration = (ms: number, tight = false): string => {
  const gap = tight ? '' : ' '
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m${gap}${String(seconds % 60).padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)

  return `${hours}h${gap}${String(minutes % 60).padStart(2, '0')}m`
}

export const formatTokens = (tokens: number): string =>
  tokens < 1000
    ? String(tokens)
    : tokens < 1_000_000
      ? `${(tokens / 1000).toFixed(1).replace('.0', '')}k`
      : `${(tokens / 1_000_000).toFixed(1).replace('.0', '')}m`
