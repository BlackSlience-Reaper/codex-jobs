import { expect, mock, test } from 'claude-code/testing'

import {
  headLine,
  parseCodexCommand,
  parseNotification,
  parseOutput,
} from '../hooks/parse'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const pane = (surface: (typeof SURFACES)[number], bodyColumns = 44) =>
  ({
    plugin: 'codex-jobs',
    component: 'Pane',
    requestId: 'codex-jobs',
    surface,
    props: {
      title: 'Codex jobs',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

test('a Bash command is a job only when it gives Codex work', () => {
  const jobs: readonly (readonly [string, string, string?])[] = [
    ['codex exec "fix the tests"', 'exec', 'fix the tests'],
    ['codex e -m gpt-5 --json "fix"', 'exec', 'fix'],
    ['cd app && codex exec --cd . "ship it" 2>&1 | tee out.log', 'exec', 'ship it'],
    ['/opt/homebrew/bin/codex review --base main', 'review'],
    ['codex exec resume --last "go on"', 'resume', 'go on'],
    ['codex exec resume abc123 "go on"', 'resume', 'go on'],
    ['CODEX_HOME=/tmp/c timeout 600 codex exec "x"', 'exec', 'x'],
    ['nohup codex exec "x" > out.log 2>&1', 'exec', 'x'],
    ['bash -lc \'codex exec "inner"\'', 'exec', 'inner'],
    ['npx @openai/codex@latest exec "x"', 'exec', 'x'],
    ['codex cloud exec --env abc "remote"', 'cloud', 'remote'],
    ['codex exec - <<\'EOF\'\nfrom a heredoc\nEOF', 'exec', 'from a heredoc'],
    ['codex "just do it"', 'run', 'just do it'],
  ]
  for (const [command, subcommand, prompt] of jobs) {
    const parsed = parseCodexCommand(command)
    expect(parsed?.subcommand).toBe(subcommand)
    expect(parsed?.prompt).toBe(prompt)
  }

  for (const command of [
    'codex',
    'codex --version',
    'codex exec --help',
    'codex login',
    'codex mcp list',
    'codex cloud list',
    'which codex',
    'grep -r "codex exec" .',
    'echo codex exec hello',
    'ls ~/.codex',
    'brew upgrade codex',
    '# codex exec "a comment"',
    "cat > notes.md <<'EOF'\ncodex exec \"from the docs\"\nEOF",
  ]) {
    expect(parseCodexCommand(command)).toBeUndefined()
  }
})

test('the model and a shell background are read off the command', () => {
  expect(parseCodexCommand('codex exec -m gpt-5 "x"')?.model).toBe('gpt-5')
  expect(parseCodexCommand('codex exec --model=o3 "x"')?.model).toBe('o3')
  expect(parseCodexCommand('codex exec -c model="o4" "x"')?.model).toBe('o4')
  expect(parseCodexCommand('codex exec "x" &')?.isDetached).toBe(true)
  expect(parseCodexCommand('codex exec "x" | tee log &')?.isDetached).toBe(true)
  expect(parseCodexCommand('codex exec "x" && echo done')?.isDetached).toBe(false)
  expect(parseCodexCommand('codex exec "x" > o.log 2>&1')?.isDetached).toBe(false)
})

test('--json events give the tools, the tokens and the answer', () => {
  const output = parseOutput(
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"npm test"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"file_change"}}',
      '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"All green."}}',
      '{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":234}}',
    ].join('\n'),
  )
  expect(output.tokens).toBe(1234)
  expect(output.toolCalls).toBe(2)
  expect(output.activity).toEqual(['$ npm test', 'file change'])
  expect(output.outcome).toBe('All green.')
})

test('the plain log gives the tokens, the model and the answer', () => {
  const output = parseOutput(
    'model: gpt-5\nthinking\ntokens used\n12,345\nThe final answer\n',
  )
  expect(output.tokens).toBe(12345)
  expect(output.model).toBe('gpt-5')
  expect(output.outcome).toBe('The final answer')
})

test('a notification and a prompt are read', () => {
  const notice = parseNotification(
    '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<output-file>/tmp/b1.output</output-file>\n<status>failed</status>\n<summary>Exit 1</summary>\n</task-notification>',
  )
  expect(notice?.taskId).toBe('b1')
  expect(notice?.toolUseId).toBe('t1')
  expect(notice?.status).toBe('failed')
  expect(notice?.outputFile).toBe('/tmp/b1.output')
  expect(notice?.summary).toBe('Exit 1')
  expect(parseNotification('nothing here')).toBeUndefined()
  expect(headLine('<task-notification><task-id>b</task-id></task-notification>')).toBe('')
  expect(headLine('\n  fix   the tests\nmore')).toBe('fix the tests')
})

test('an empty pane says so, and other commands make no job', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'ls ~/.codex' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /No jobs yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a job opens the pane once and shows in its phase on every surface', async ($, on) => {
  mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({
    result: {
      stdout: 'tokens used\n12,345\nAll green.\n',
      stderr: '',
      interrupted: false,
    },
  }))

  await $.turn.start({ text: 'Fix the login tests', turnId: 'turn-1' })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 't1',
    command: 'codex exec -m gpt-5 "run the suite"',
    description: 'Run the suite in Codex',
  })
  expect(opened).toEqual(['codex-jobs'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Fix the login tests/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/1 job · .* · done/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'job-t1' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'job-t1' }))?.props.label).toBe(
      'Run the suite in Codex',
    )
    expect(await ui.find({ type: 'Text', text: /12\.3k tok/ })).toBeDefined()
    // One phase: the card's title says it, so no row of phases repeats it.
    expect(await ui.find({ type: 'Text', text: /❯/ })).toBeUndefined()

    await ui.press({ key: 'job-t1' })
    expect(await ui.find({ type: 'Text', text: /Completed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /run the suite/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /All green\./ })).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /Completed/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a failed call shows why, and the phase turns failed', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({
    isError: true,
    result: undefined,
    text: 'Exit code 2\nboom',
  }))
  await $.tool.call({ tool: 'Bash', command: 'codex exec "x"' })

  const ui = await $.ui.mount(pane('desktop', 80))
  expect(await ui.find({ type: 'Text', text: /✗/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Exit code 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/1 job · .* · failed/ })).toBeDefined()
  await ui.unmount()
})

test('several phases list beside the card when wide, and a press picks one', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await $.turn.start({ text: 'First ask', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'codex exec "one"' })
  await $.turn.start({ text: 'Second ask', turnId: 'turn-2' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'codex exec "two"' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface, 80))
    expect(await ui.find({ type: 'Text', text: /^Phases$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'job-b' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'job-a' })).toBeUndefined()

    await ui.press({ key: 'phase-turn-1' })
    expect(await ui.find({ type: 'Button', key: 'job-a' })).toBeDefined()
    await ui.press({ key: 'phase-turn-2' })
    await ui.unmount()
  }
})

const FOOTER = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'codex-jobs',
    component: 'SessionMode',
    surface,
    props: { modes: [] },
  }) as const

test('the footer button opens and closes the pane, and keeps the modes', async ($, on) => {
  mock.clock(on)
  const calls: string[] = []
  let isUp = false
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine modes</Text>
  })
  on('ui.panes', () => ({
    value: isUp
      ? [
          {
            id: 'codex-jobs',
            title: 'Codex jobs',
            isShown: true,
            isFocused: false,
            isPlaced: true,
          },
        ]
      : [],
  }))
  on('ui.open', () => {
    calls.push('open')
    isUp = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    calls.push('close')
    isUp = false

    return { value: undefined }
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    calls.length = 0
    const ui = await $.ui.mount(FOOTER(surface))
    expect(await ui.find({ type: 'Text', text: /engine modes/ })).toBeDefined()
    const button = await ui.find({ type: 'Button', key: 'codex-workflow' })
    expect(button?.props.label).toBe('Codex workflow')
    expect(button?.props.dimColor).toBe(true)

    await ui.press({ key: 'codex-workflow' })
    expect(calls).toEqual(['open'])
    expect((await ui.find({ key: 'codex-workflow' }))?.props.dimColor).toBe(false)

    await ui.press({ key: 'codex-workflow' })
    expect(calls).toEqual(['open', 'close'])

    // Closed by the person's press: a new job leaves it closed.
    await $.tool.call({ tool: 'Bash', command: 'codex exec "x"' })
    expect(calls).toEqual(['open', 'close'])
    await ui.unmount()
  }
})

test('a background job runs until its notification, and can be filtered', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'tokens used\n100\nDone.\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.stat', () => ({
    value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  let id = 0
  on('tool.call', () => {
    id++

    return {
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        backgroundTaskId: `bg-${id}`,
      },
      text: `Command running in background with ID: bg-${id}. Output is being written to: /tmp/bg-${id}.output. You will be notified when it completes.`,
    }
  })

  await $.tool.call({ tool: 'Bash', command: 'codex exec "one"', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'codex exec "two"', run_in_background: true })

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /0\/2 jobs/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'stop-all' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'filter' })).toBeUndefined()

  await $.prompt.submit({
    text: '<task-notification><task-id>bg-1</task-id><status>completed</status><summary>ok</summary></task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  })
  expect(await ui.find({ type: 'Text', text: /1\/2 jobs/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'filter' })).toBeDefined()

  await ui.press({ key: 'filter' })
  expect(await ui.find({ type: 'Text', text: /showing 1 running/ })).toBeDefined()
  await ui.press({ key: 'filter' })
  expect(await ui.find({ type: 'Text', text: /showing 1 completed/ })).toBeDefined()
  await ui.press({ key: 'filter' })
  expect(await ui.find({ type: 'Text', text: /^2 jobs$/ })).toBeDefined()
  await ui.unmount()
})

test('stop asks the engine to stop the task and marks the job', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const stopped: unknown[] = []
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskStop') {
      stopped.push(e.task_id)

      return { result: { message: 'stopped' } }
    }

    return {
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        backgroundTaskId: 'bg-9',
      },
      text: 'Command running in background with ID: bg-9.',
    }
  })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 't9',
    command: 'codex exec "long"',
    run_in_background: true,
  })

  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'job-t9' })
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Still running/ })).toBeDefined()

  await ui.press({ key: 'stop' })
  expect(stopped).toEqual(['bg-9'])
  expect(await ui.find({ type: 'Text', text: /Stopped/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeUndefined()
  await ui.unmount()
})
