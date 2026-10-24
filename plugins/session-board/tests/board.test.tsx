import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__session-board__board'

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'session-board',
  props: {
    title: 'Session board',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

function engine(on: On, session: { id: string }) {
  mock.store(on)
  on('session.id', () => ({ value: session.id }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('items the tool adds show in the pane, on every surface', async ($, on) => {
  engine(on, { id: 's1' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const added = await $.tool.call({
    tool: TOOL,
    goal: 'Ship the refund fix',
    add: [
      { section: 'questions', text: 'Backfill old refunds?' },
      { section: 'links', text: 'PR 123', url: 'https://github.com/o/r/pull/123' },
    ],
  })
  expect(added.result).toBe('Board updated. Added q1, l2.')
  await $.tool.call({ tool: TOOL, update: [{ id: 'q1', isDone: true }] })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /refund fix/ }))?.text).toBe(
      'Ship the refund fix',
    )
    expect(await ui.find({ type: 'Markdown', text: /^✓ Backfill/ })).toBeDefined()
    expect(
      await ui.find({ type: 'Markdown', text: /\[PR 123\]\(https:\/\/github/ }),
    ).toBeDefined()
    await ui.unmount()
  }
})

test('a change naming an unknown item is refused whole', async ($, on) => {
  engine(on, { id: 's1' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, add: [{ section: 'next', text: 'Run tests' }] })

  const refused = await $.tool.call({
    tool: TOOL,
    add: [{ section: 'ideas', text: 'Cache it' }],
    remove: ['q9'],
  })
  expect(refused.deny).toContain('q9')

  const board = await $.tool.call({ tool: TOOL })
  expect(board.result).toContain('n1 Run tests')
  expect(board.result).not.toContain('Cache it')
})

test('each session keeps its own board', async ($, on) => {
  const session = { id: 's1' }
  engine(on, session)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, goal: 'First session' })

  session.id = 's2'
  const fresh = await $.tool.call({ tool: TOOL })
  expect(fresh.result).toContain('goal: (none)')

  session.id = 's1'
  const resumed = await $.tool.call({ tool: TOOL })
  expect(resumed.result).toContain('goal: First session')
})

test('a board an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({
    value: { value: { goal: 'old', items: [{ text: 'x' }] }, version: 1 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/^Nothing tracked yet/)
  await ui.unmount()
})
