import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  Timer,
  ToolCallResult,
} from 'claude-code'

import type {
  CodexJob,
  CodexPhase,
  JobFilter,
  JobStatus,
  JobsView,
} from '../types'

import {
  clip,
  formatDuration,
  formatTokens,
  headLine,
  parseCodexCommand,
  parseNotification,
  parseOutput,
  widthOf,
  wrapLines,
} from './parse'

const PANE = 'codex-jobs'
const TITLE = 'Codex jobs'
const MAX_JOBS = 200
const TAIL_BYTES = 1024 * 1024
const PROMPT_LINES = 2
const ACTIVITY_LINES = 5
const OUTCOME_LINES = 12
const TWO_COLUMNS_FROM = 64
const OUTPUT_FILE = /Output is being written to:\s*(.+?\.output)(?=[.\s]|$)/

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'codex-jobs', key: 'jobs' } as const, [], {
  shape: 'jobs-1',
})
const phases = atom({ plugin: 'codex-jobs', key: 'phases' } as const, [], {
  shape: 'phases-1',
})
const turn = atom({ plugin: 'codex-jobs', key: 'turn' } as const, {}, {
  shape: 'turn-1',
})
const view = atom(
  { plugin: 'codex-jobs', key: 'view' } as const,
  { filter: 'all', isExpanded: false, isDismissed: false },
  { shape: 'view-1' },
)

// The native workflow view's glyphs, colors and words for an agent's state.
const STATUS: Readonly<
  Record<JobStatus, { glyph: string; color: string; label: string }>
> = {
  running: { glyph: '⏺', color: 'subtle', label: 'Running' },
  done: { glyph: '✓', color: 'success', label: 'Completed' },
  failed: { glyph: '✗', color: 'error', label: 'Failed' },
  stopped: { glyph: '◯', color: 'subtle', label: 'Stopped' },
  unknown: { glyph: '?', color: 'warning', label: 'Unknown' },
}
const FILTERS: readonly JobFilter[] = [
  'all',
  'running',
  'failed',
  'done',
  'stopped',
  'unknown',
]

type PhaseSummary = {
  phase: CodexPhase
  own: CodexJob[]
  done: number
  total: number
  status: 'running' | 'done' | 'failed' | 'unknown'
}

const isRunning = (job: CodexJob): boolean => job.status === 'running'

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

const summarize = (phase: CodexPhase, list: readonly CodexJob[]): PhaseSummary => {
  const own = list.filter(job => job.phaseId === phase.id)
  const has = (...states: JobStatus[]) =>
    own.some(job => states.includes(job.status))

  return {
    phase,
    own,
    done: own.filter(job => job.status === 'done').length,
    total: own.length,
    status: has('running')
      ? 'running'
      : has('failed', 'stopped')
        ? 'failed'
        : has('unknown')
          ? 'unknown'
          : 'done',
  }
}

/** The time at least one job ran: overlapping jobs count once. */
const busyMs = (list: readonly CodexJob[], now: number): number => {
  const spans = list
    .map(job => [job.startedAt, job.endedAt ?? now] as const)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let covered = Number.NEGATIVE_INFINITY
  for (const [from, to] of spans) {
    const start = Math.max(from, covered)
    if (to > start) {
      total += to - start
      covered = to
    }
  }

  return total
}

const jobStats = (job: CodexJob, now: number): string[] => {
  const stats: string[] = []
  if (job.subcommand !== 'exec') stats.push(job.subcommand)
  if (job.tokens !== undefined) stats.push(`${formatTokens(job.tokens)} tok`)
  if (job.toolCalls) stats.push(plural(job.toolCalls, 'tool'))
  stats.push(formatDuration((job.endedAt ?? now) - job.startedAt))

  return stats
}

const withOutput = (job: CodexJob, raw: string): CodexJob => {
  if (raw.trim() === '') return job
  const output = parseOutput(raw)

  return {
    ...job,
    tokens: output.tokens ?? job.tokens,
    model: job.model ?? output.model,
    toolCalls: output.toolCalls ?? job.toolCalls,
    activity: output.activity.length > 0 ? output.activity : job.activity,
    outcome: isRunning(job) ? job.outcome : output.outcome,
    note: output.error ?? job.note,
  }
}

const settleCall = (
  job: CodexJob,
  ran: ToolCallResult<'Bash'>,
  isDetached: boolean,
  now: number,
): CodexJob => {
  if (ran.deny !== undefined) {
    return { ...job, status: 'failed', endedAt: now, note: ran.deny }
  }
  if (ran.isError === true) {
    const text = ran.text ?? ''
    const failed = withOutput({ ...job, status: 'failed', endedAt: now }, text)

    return { ...failed, note: failed.note ?? (headLine(text) || 'The command failed.') }
  }
  const { backgroundTaskId, stdout, stderr, interrupted } = ran.result
  if (backgroundTaskId) {
    return {
      ...job,
      taskId: backgroundTaskId,
      outputFile: OUTPUT_FILE.exec(ran.text ?? '')?.[1]?.trim(),
    }
  }
  const text = [stdout, stderr].filter(Boolean).join('\n')
  if (interrupted) {
    return withOutput({ ...job, status: 'stopped', endedAt: now }, text)
  }
  if (isDetached) {
    return {
      ...withOutput({ ...job, status: 'unknown', endedAt: now }, text),
      note: 'The shell put it in the background (&), so its end is not tracked.',
    }
  }

  return withOutput({ ...job, status: 'done', endedAt: now }, text)
}

let ticker: Timer | undefined
let ticks = 0

async function setView(
  $: EngineInterface,
  patch: Partial<JobsView>,
): Promise<void> {
  await update($, view, current => ({ ...current, ...patch }))
}

async function patchJob(
  $: EngineInterface,
  id: string,
  patch: (job: CodexJob) => CodexJob,
): Promise<void> {
  await update($, jobs, list =>
    list.map(job => (job.id === id ? patch(job) : job)),
  )
}

async function readTail(
  $: EngineInterface,
  file: string,
): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(
    ['tail', '-c', String(TAIL_BYTES), file],
    { timeoutMs: 5000 },
  )

  return exitCode === 0 ? stdout : undefined
}

async function tick($: EngineInterface): Promise<void> {
  ticks++
  const list = await read($, jobs)
  if (!list.some(isRunning)) {
    ticker?.cancel()
    ticker = undefined
  }
  if (ticks % 3 === 0) {
    const { jobId } = await read($, view)
    const open = list.find(job => job.id === jobId && isRunning(job))
    const text = open?.outputFile
      ? await readTail($, open.outputFile)
      : undefined
    if (open && text !== undefined) {
      await patchJob($, open.id, job => withOutput(job, text))
    }
  }
  $.ui.invalidate('ui.render')
}

// The clock runs only while a job is still counting up.
function keepTicking($: EngineInterface): void {
  ticker ??= $.clock.every(1000, () => {
    void tick($).catch(() => undefined)
  })
}

async function startJob(
  $: EngineInterface,
  id: string,
  command: string,
  description: string | undefined,
  parsed: NonNullable<ReturnType<typeof parseCodexCommand>>,
): Promise<CodexJob> {
  const startedAt = await $.clock.now()
  const current = await read($, turn)
  const phaseId = current.id ?? 'session'
  const known = await read($, phases)
  if (!known.some(phase => phase.id === phaseId)) {
    await update($, phases, list => [
      ...list,
      { id: phaseId, title: current.title || `Turn ${list.length + 1}` },
    ])
    await setView($, { phaseId: undefined, filter: 'all' })
  }
  const job: CodexJob = {
    id,
    phaseId,
    label:
      description?.trim() ||
      headLine(parsed.prompt ?? '') ||
      `codex ${parsed.subcommand}`,
    subcommand: parsed.subcommand,
    prompt: parsed.prompt,
    command,
    model: parsed.model,
    status: 'running',
    startedAt,
  }
  const list = await update($, jobs, all => [...all, job].slice(-MAX_JOBS))
  await update($, phases, all =>
    all.filter(phase => list.some(one => one.phaseId === phase.id)),
  )
  keepTicking($)
  const { isDismissed } = await read($, view)
  if (!isDismissed) void openPane($).catch(() => undefined)

  return job
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
  $.ui.invalidate('ui.render')
}

async function isPaneUp($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()

  return panes.some(pane => pane.id === PANE && pane.isPlaced)
}

async function togglePane($: EngineInterface): Promise<void> {
  const isUp = await isPaneUp($)
  await setView($, { isDismissed: isUp })
  if (isUp) {
    await $.ui.close({ id: PANE })
    $.ui.invalidate('ui.render')
  } else {
    await openPane($)
  }
}

async function markStopped($: EngineInterface, taskId: string): Promise<void> {
  const now = await $.clock.now()
  await update($, jobs, list =>
    list.map(job =>
      job.taskId === taskId && isRunning(job)
        ? { ...job, status: 'stopped', endedAt: now }
        : job,
    ),
  )
}

async function settleNotification(
  $: EngineInterface,
  text: string,
): Promise<void> {
  if (!text.includes('<task-notification')) return
  const notice = parseNotification(text)
  if (!notice) return
  const list = await read($, jobs)
  const job = list.find(
    one =>
      (notice.taskId !== undefined && one.taskId === notice.taskId) ||
      one.id === notice.toolUseId,
  )
  if (!job) return
  const file = notice.outputFile ?? job.outputFile
  const raw = file ? await readTail($, file).catch(() => undefined) : undefined
  // A notice waits for an idle session, so the file's own time says when the
  // job really ended.
  const written = file
    ? await $.fs.stat(file).then(
        stat => stat.mtimeMs,
        () => undefined,
      )
    : undefined
  const endedAt =
    written !== undefined && written >= job.startedAt
      ? written
      : await $.clock.now()
  const status: JobStatus =
    notice.status === 'completed'
      ? 'done'
      : notice.status === 'failed'
        ? 'failed'
        : notice.status === 'killed'
          ? 'stopped'
          : 'unknown'
  await patchJob($, job.id, one => {
    const settled = withOutput(
      { ...one, status, endedAt, outputFile: file },
      raw ?? '',
    )

    return status === 'done' || status === 'stopped'
      ? { ...settled, note: undefined }
      : { ...settled, note: settled.note ?? notice.summary }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE,
      description: 'Show the Codex jobs of this session in a pane',
    })
    if ((await read($, jobs)).some(isRunning)) keepTicking($)

    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    await setView($, { isDismissed: false })
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: `${TITLE} pane opened.` }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') {
      await setView($, { isDismissed: true })
    }

    return closed
  })

  // The toggle in the prompt footer, beside the engine's own mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const below = await next(e)
    await read($, view)
    const isUp = await isPaneUp($)

    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Button
          key="codex-workflow"
          label="Codex workflow"
          dimColor={!isUp}
          onPress={() => void togglePane($).catch(() => undefined)}
        />
        {below}
      </Box>
    )
  })

  // A turn with no typed prompt carries on from the one that asked: its jobs
  // stay in that phase.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const title = headLine(e.text)
      await update($, turn, current =>
        title !== ''
          ? { id: e.turnId, title }
          : current.id !== undefined
            ? current
            : { id: e.turnId },
      )
    }

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const parsed = parseCodexCommand(e.command)
    if (!parsed) return next(e)
    const job = await startJob(
      $,
      e.tool_use_id,
      e.command,
      e.description,
      parsed,
    ).catch(() => undefined)
    const ran = await next(e)
    if (job) {
      const now = await $.clock.now()
      await patchJob($, job.id, one =>
        settleCall(one, ran, parsed.isDetached, now),
      ).catch(() => undefined)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id && ran.deny === undefined && ran.isError !== true) {
      await markStopped($, id).catch(() => undefined)
    }

    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    await settleNotification($, e.text).catch(() => undefined)

    return next(e)
  })

  // The net under a lost notification: the session no longer holds the task,
  // and nothing said how it ended.
  on('classic.Stop', async ($, e, next) => {
    const inFlight = e.background_tasks
    if (inFlight) {
      const now = await $.clock.now()
      await update($, jobs, list =>
        list.map(job =>
          isRunning(job) &&
          job.taskId !== undefined &&
          !inFlight.some(task => task.id === job.taskId)
            ? {
                ...job,
                status: 'unknown',
                endedAt: now,
                note: 'The task ended without a completion notice.',
              }
            : job,
        ),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, jobs)
    const known = await read($, phases)
    const state = await read($, view)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)
    const isTerminal = e.surface === 'terminal'
    // A proportional face fits more than the code-font cells a surface counts.
    const fit = isTerminal ? 1 : 1.3
    const summaries = known.map(phase => summarize(phase, list))
    const selected =
      summaries.find(one => one.phase.id === state.phaseId) ??
      summaries.findLast(one => one.status === 'running') ??
      summaries.at(-1)

    const stopJob = async (job: CodexJob): Promise<void> => {
      if (job.taskId === undefined) return
      const ran = await $.tool.call({
        tool: 'TaskStop',
        task_id: job.taskId,
        consent: `The user pressed "stop" on the ${TITLE} pane`,
      })
      if (ran.deny === undefined && ran.isError !== true) {
        await markStopped($, job.taskId)
      } else {
        $.ui.toast(`Could not stop ${job.label}.`)
      }
    }

    const header = (name: string, subtext: string, stats: string) => (
      <Box flexDirection="column">
        {isTerminal && <Text>{'─'.repeat(width)}</Text>}
        <Text color="permission" weight="semibold">
          {clip(name, width)}
        </Text>
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Box flexShrink={1} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {subtext}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor tabular>
              {stats}
            </Text>
          </Box>
        </Box>
      </Box>
    )

    const footer = (
      actions: readonly {
        key: string
        label: string
        hotkey: string
        onPress: () => void
      }[],
      hint: string,
    ) => (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {actions.map(action => (
            <Button
              key={action.key}
              label={action.label}
              hotkey={action.hotkey}
              plain
              dimColor
              onPress={action.onPress}
            />
          ))}
        </Box>
        {isTerminal && (
          <Text dimColor italic wrap="truncate-end">
            {e.props.isFocused ? hint : 'ctrl+x tab to use the keyboard'}
          </Text>
        )}
      </Box>
    )

    const totals = () => {
      const done = list.filter(job => job.status === 'done').length
      const suffix = list.some(isRunning)
        ? ''
        : list.some(job => job.status === 'failed')
          ? ' · failed'
          : list.some(job => job.status === 'stopped')
            ? ' · stopped'
            : list.length > 0
              ? ' · done'
              : ''

      return `${done}/${plural(list.length, 'job')} · ${formatDuration(busyMs(list, now), true)}${suffix}`
    }

    if (list.length === 0 || !selected) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {header(TITLE, 'This session', totals())}
          <Box flexDirection="column">
            <Text dimColor>No jobs yet.</Text>
            <Text dimColor>The Codex commands Claude runs here show up in this pane.</Text>
          </Box>
        </Box>
      )
    }

    const section = (
      title: string,
      lines: readonly string[],
      options: {
        keep: number
        fromEnd?: boolean
        color?: string
        empty?: string
      },
    ) => {
      const hidden = state.isExpanded ? 0 : lines.length - options.keep
      const isFolded = hidden >= 2
      const shown = !isFolded
        ? lines
        : options.fromEnd
          ? lines.slice(-options.keep)
          : lines.slice(0, options.keep)
      const more = isFolded
        ? options.fromEnd
          ? ` · last ${shown.length} of ${lines.length}`
          : ` · ${plural(lines.length, 'line')}`
        : ''

      return (
        <Box flexDirection="column">
          <Text>
            <Text dimColor weight="semibold">
              {title}
            </Text>
            <Text dimColor>{more}</Text>
          </Text>
          {lines.length === 0 ? (
            <Text dimColor> {options.empty ?? ''}</Text>
          ) : (
            shown.map(line => (
              <Text mono color={options.color} dimColor={options.color === undefined}>
                {'  '}
                {line}
              </Text>
            ))
          )}
          {isFolded && !options.fromEnd && (
            <Text dimColor>
              {'  '}… {plural(hidden, 'more line')}
            </Text>
          )}
        </Box>
      )
    }

    const openJob = list.find(job => job.id === state.jobId)
    if (openJob) {
      const phase = summaries.find(one => one.phase.id === openJob.phaseId)
      const position = phase ? phase.own.indexOf(openJob) + 1 : 1
      const status = STATUS[openJob.status]
      const room = width - 6
      const meta = [openJob.model, openJob.subcommand].filter(Boolean).join(' · ')
      const toLines = (text: string | undefined) =>
        text ? wrapLines(text, room) : []
      const promptLines = toLines(openJob.prompt ?? openJob.command)
      const activityLines = (openJob.activity ?? []).flatMap(toLines)
      const outcomeLines = toLines(openJob.outcome)
      const canFold =
        promptLines.length - PROMPT_LINES >= 2 ||
        activityLines.length - ACTIVITY_LINES >= 2 ||
        outcomeLines.length - OUTCOME_LINES >= 2
      const noteColor = openJob.status === 'failed' ? 'error' : undefined
      const stop =
        isRunning(openJob) && openJob.taskId !== undefined
          ? [
              {
                key: 'stop',
                label: 'stop',
                hotkey: 'x',
                onPress: () => void stopJob(openJob),
              },
            ]
          : []
      const fold = canFold
        ? [
            {
              key: 'fold',
              label: state.isExpanded ? 'collapse' : 'expand',
              hotkey: 'e',
              onPress: () =>
                void setView($, { isExpanded: !state.isExpanded }),
            },
          ]
        : []

      return (
        <Box flexDirection="column" rowGap={1}>
          {header(TITLE, phase?.phase.title ?? '', totals())}
          <Box
            flexDirection="column"
            rowGap={1}
            borderStyle="single"
            borderColor="subtle"
            paddingX={1}
          >
            <Text>
              <Text color="permission" weight="semibold">
                {clip(openJob.label, Math.max(8, Math.floor(room * fit) - 8))}
              </Text>
              <Text dimColor>
                {' · '}
                {position}/{phase?.total ?? 1}
              </Text>
            </Text>
            <Box flexDirection="column">
              <Text>
                <Text color={status.color}>{status.glyph} </Text>
                <Text color={status.color} weight="semibold">
                  {status.label}
                </Text>
                <Text dimColor>{meta ? ` · ${meta}` : ''}</Text>
              </Text>
              <Text dimColor tabular>
                {jobStats(openJob, now)
                  .filter(stat => stat !== openJob.subcommand)
                  .join(' · ')}
              </Text>
            </Box>
            {section('Prompt', promptLines, { keep: PROMPT_LINES })}
            {section('Activity', activityLines, {
              keep: ACTIVITY_LINES,
              fromEnd: true,
              empty: !isRunning(openJob)
                ? 'No activity captured.'
                : openJob.outputFile
                  ? 'No output yet.'
                  : 'Output appears when the job finishes.',
            })}
            {openJob.note ? (
              section('Outcome', toLines(openJob.note), {
                keep: OUTCOME_LINES,
                color: noteColor,
              })
            ) : (
              section('Outcome', outcomeLines, {
                keep: OUTCOME_LINES,
                empty: isRunning(openJob)
                  ? 'Still running…'
                  : openJob.status === 'stopped'
                    ? 'Stopped before it finished.'
                    : 'No output.',
              })
            )}
          </Box>
          {footer(
            [
              {
                key: 'back',
                label: 'back',
                hotkey: 'b',
                onPress: () =>
                  void setView($, { jobId: undefined, isExpanded: false }),
              },
              ...stop,
              ...fold,
            ],
            'tab select · enter press',
          )}
        </Box>
      )
    }

    // One phase says nothing the card's title does not: the list is left out,
    // as the native view draws a flat list for a run with no phases.
    const hasPhases = summaries.length > 1
    const isTwoColumns = hasPhases && width >= TWO_COLUMNS_FROM
    const longest = Math.max(
      14,
      ...summaries.map(
        (one, index) =>
          widthOf(one.phase.title) +
          widthOf(String(index + 1)) +
          widthOf(`${one.done}/${one.total}`) +
          5,
      ),
    )
    const leftWidth = Math.max(12, Math.min(34, longest, width - 24))
    const phaseRoom = Math.floor((isTwoColumns ? leftWidth - 4 : width) * fit)
    const jobRoom = Math.floor(
      ((isTwoColumns ? width - leftWidth - 1 : width) - 4) * fit,
    )

    const phaseRow = (one: PhaseSummary, index: number) => {
      const isSelected = one === selected
      const tone = isSelected
        ? 'permission'
        : one.status === 'done'
          ? 'success'
          : one.status === 'failed'
            ? 'error'
            : one.status === 'unknown'
              ? 'warning'
              : undefined
      const mark =
        one.status === 'done'
          ? '✓'
          : one.status === 'failed'
            ? '✗'
            : one.status === 'unknown'
              ? '?'
              : String(index + 1)
      const count = `${one.done}/${one.total}`
      const title = clip(
        one.phase.title,
        Math.max(4, phaseRoom - widthOf(mark) - widthOf(count) - 5),
      )

      // A desktop draws a Button's label in one style, so what carries a color
      // stands beside it.
      return (
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={0}>
            <Text color={tone} dimColor={tone === undefined}>
              {isSelected ? '❯' : ' '} {mark}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {isSelected ? (
              <Text color="permission" weight="semibold">
                {title}
              </Text>
            ) : (
              <Button
                key={`phase-${one.phase.id}`}
                label={title}
                plain
                dimColor
                onPress={() =>
                  void setView($, { phaseId: one.phase.id, filter: 'all' })
                }
              />
            )}
          </Box>
          <Box flexShrink={0}>
            <Text color={tone} dimColor={tone === undefined} tabular>
              {count}
            </Text>
          </Box>
        </Box>
      )
    }

    const jobRow = (job: CodexJob) => {
      const status = STATUS[job.status]
      const parts = jobStats(job, now)
      // Duration last and kept: the rest give way first when the pane is thin.
      while (parts.length > 1 && widthOf(parts.join(' · ')) > jobRoom - 14) {
        parts.shift()
      }
      const stats = parts.join(' · ')
      const label = clip(job.label, Math.max(8, jobRoom - 2 - widthOf(stats) - 2))

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Box flexShrink={0}>
              <Text color={status.color}>{status.glyph}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Button
                key={`job-${job.id}`}
                label={label}
                plain
                dimColor={job.status === 'done'}
                onPress={() =>
                  void setView($, { jobId: job.id, isExpanded: false })
                }
              />
            </Box>
            <Box flexShrink={0}>
              <Text dimColor tabular>
                {stats}
              </Text>
            </Box>
          </Box>
          {job.status === 'failed' && job.note !== undefined && (
            <Text color="error" wrap="truncate-end">
              {'  '}
              {clip(job.note, Math.max(8, jobRoom - 2))}
            </Text>
          )}
        </Box>
      )
    }

    const own = selected.own
    const present = FILTERS.filter(
      filter => filter === 'all' || own.some(job => job.status === filter),
    )
    const filter = present.includes(state.filter) ? state.filter : 'all'
    const shown = filter === 'all' ? own : own.filter(job => job.status === filter)
    const filterWord = filter === 'all' ? '' : STATUS[filter].label.toLowerCase()
    const stoppable = own.filter(
      job => isRunning(job) && job.taskId !== undefined,
    )

    const jobsCard = (
      <Box
        flexDirection="column"
        rowGap={1}
        flexGrow={1}
        borderStyle="single"
        borderColor="subtle"
        paddingX={1}
      >
        <Box flexDirection="column">
          <Text color="permission" weight="semibold">
            {clip(selected.phase.title, Math.max(8, jobRoom))}
          </Text>
          <Text dimColor>
            {filter === 'all'
              ? plural(shown.length, 'job')
              : `showing ${shown.length} ${filterWord}`}
          </Text>
        </Box>
        <Box flexDirection="column">{shown.map(jobRow)}</Box>
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        {header(TITLE, 'This session', totals())}
        {isTwoColumns ? (
          <Box flexDirection="row" columnGap={1}>
            <Box
              flexDirection="column"
              flexShrink={0}
              width={leftWidth}
              borderStyle="single"
              borderColor="subtle"
              paddingX={1}
            >
              <Text weight="semibold">Phases</Text>
              {summaries.map(phaseRow)}
            </Box>
            {jobsCard}
          </Box>
        ) : (
          <Box flexDirection="column" rowGap={1}>
            {hasPhases && (
              <Box flexDirection="column">{summaries.map(phaseRow)}</Box>
            )}
            {jobsCard}
          </Box>
        )}
        {footer(
          [
            ...(present.length > 2
              ? [
                  {
                    key: 'filter',
                    label: filterWord ? `filter: ${filterWord}` : 'filter',
                    hotkey: 'f',
                    onPress: () => {
                      const next =
                        present[(present.indexOf(filter) + 1) % present.length]
                      void setView($, { filter: next ?? 'all' })
                    },
                  },
                ]
              : []),
            ...(stoppable.length > 0
              ? [
                  {
                    key: 'stop-all',
                    label: 'stop all',
                    hotkey: 'x',
                    onPress: () => {
                      for (const job of stoppable) void stopJob(job)
                    },
                  },
                ]
              : []),
          ],
          'tab select · enter open',
        )}
      </Box>
    )
  })
}
