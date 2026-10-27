import { expect, test } from 'claude-code/testing'

import { board, CONFIG_FILE, engine, HOME, json, open, PANE, start, world } from './engine'

const NOW = Date.parse('2026-10-16T14:00:00Z')
const TOOL = 'mcp__board__session'
const WORK_FILE = `${HOME}/boards/work.json`
const CONFIG = { boards: [{ id: 'work', path: '~/boards/work.json', layout: 'sections' }] }
const WORK = {
  updated_at: '2026-10-16T13:55:00Z',
  items: [
    { id: 'a', section: 'needs', title: 'Answer the vendor' },
    { id: 'b', section: 'needs', title: 'Sign the form' },
    { id: 'c', section: 'next', title: 'Write the doc' },
  ],
}
const withWork = () => world({ files: { [CONFIG_FILE]: json(CONFIG), [WORK_FILE]: json(WORK) } })

test('items the session tool adds show in the pane, on every surface', async ($, on) => {
  engine(on, world(), NOW)
  await start($)

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
    expect((await ui.find({ type: 'Text', text: /refund fix/ }))?.text).toBe('Ship the refund fix')
    expect(await ui.find({ type: 'Text', text: 'Backfill old refunds?' })).toBeUndefined()
    await ui.press({ key: 'done-questions' })
    expect(await ui.find({ type: 'Text', text: 'Backfill old refunds?' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.press({ key: 'unfold-links' })
    expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'https://github.com/o/r/pull/123', label: 'PR 123' } })
    await ui.press({ key: 'fold-section-links' })
    await ui.press({ key: 'done-questions' })
    await ui.unmount()
  }
})

test('a session item draws as one plain line until pressed, then as its whole markdown', async ($, on) => {
  engine(on, world(), NOW)
  await start($)
  await $.tool.call({
    tool: TOOL,
    add: [
      { section: 'next', text: 'Run `gradle test` on [the PR](https://github.com/o/r/pull/1)' },
      { section: 'decisions', text: 'Ship behind a gate' },
    ],
  })

  const ui = await open($, 'session')
  expect(await ui.find({ type: 'Text', text: 'Run gradle test on the PR' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'n1' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /gradle test/ })).toBeUndefined()

  await ui.press({ key: 'open-n1' })
  expect(await ui.find({ type: 'Markdown', text: 'Run `gradle test` on [the PR](https://github.com/o/r/pull/1)' })).toBeDefined()
  await ui.press({ key: 'fold-n1' })
  expect(await ui.find({ type: 'Markdown', text: /gradle test/ })).toBeUndefined()
  await ui.unmount()
})

test('next steps and questions start open, the other sections fold into one row, and each heading folds its own', async ($, on) => {
  engine(on, world(), NOW)
  await start($)
  await $.tool.call({
    tool: TOOL,
    add: [
      { section: 'next', text: 'Run tests' },
      { section: 'decisions', text: 'Ship behind a gate' },
      { section: 'ideas', text: 'Cache it' },
    ],
  })

  const ui = await open($, 'session')
  expect(await ui.find({ key: 'folded', text: /^Decisions 1\s*·\s*Ideas 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Ship behind a gate' })).toBeUndefined()

  await ui.press({ key: 'unfold-decisions' })
  expect(await ui.find({ type: 'Text', text: 'Ship behind a gate' })).toBeDefined()
  expect(await ui.find({ key: 'folded', text: /^Ideas 1$/ })).toBeDefined()

  await ui.press({ key: 'fold-section-next' })
  expect(await ui.find({ type: 'Text', text: 'Run tests' })).toBeUndefined()
  expect(await ui.find({ key: 'unfold-next' })).toMatchObject({ props: { label: 'Next 1' } })
  await ui.press({ key: 'fold-section-decisions' })
  await ui.press({ key: 'unfold-next' })
  await ui.unmount()
})

test('a session change naming an unknown item is refused whole', async ($, on) => {
  engine(on, world(), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ section: 'next', text: 'Run tests' }] })

  const refused = await $.tool.call({ tool: TOOL, add: [{ section: 'ideas', text: 'Cache it' }], remove: ['q9'] })
  expect(refused.deny).toContain('q9')

  const board = await $.tool.call({ tool: TOOL })
  expect(board.result).toContain('n1 Run tests')
  expect(board.result).not.toContain('Cache it')
})

test('each session keeps its own session board', async ($, on) => {
  const w = world()
  engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, goal: 'First session' })

  w.session.id = 's2'
  expect((await $.tool.call({ tool: TOOL })).result).toContain('goal: (none)')

  w.session.id = 's1'
  expect((await $.tool.call({ tool: TOOL })).result).toContain('goal: First session')
})

test('a session board an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { goal: 'old', items: [{ text: 'x' }] }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Nothing tracked yet/ })).toBeDefined()
  await ui.unmount()
})

test('the switcher lists each view with something to show and how many of its items wait on the person', async ($, on) => {
  engine(on, withWork(), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ section: 'questions', text: 'Which bank?' }] })

  const ui = await open($, 'session')
  expect(await ui.find({ key: 'tab-session', text: 'session 1' })).toBeDefined()
  expect(await ui.find({ key: 'tab-work', text: 'work 2' })).toBeDefined()
  expect(await ui.find({ key: 'switcher', text: /^session 1\s*│\s*work 2$/ })).toBeDefined()
  expect(await ui.find({ key: 'tab-prs' })).toBeUndefined()
  expect(await ui.find({ key: 'tab-review' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Which bank?' })).toBeDefined()

  await ui.press({ key: 'tab-work' })
  expect(await ui.find({ type: 'Text', text: 'Answer the vendor' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which bank?' })).toBeUndefined()
  await ui.unmount()
})

test('/board opens the pane on a named view by prefix, and the same command again closes it', async ($, on) => {
  const w = withWork()
  engine(on, w, NOW)
  await start($)
  expect(w.opens).toEqual([])

  const ui = await open($, 'wo')
  expect(w.opens).toContainEqual(expect.objectContaining({ id: 'board', focus: true }))
  expect(await ui.find({ type: 'Text', text: 'Sign the form' })).toBeDefined()
  await ui.unmount()

  await board($, 'work')
  expect(w.closes).toContainEqual(expect.objectContaining({ id: 'board' }))
})

test('/board with another view named switches the open pane to it instead of closing', async ($, on) => {
  const w = withWork()
  engine(on, w, NOW)
  await start($)

  await board($, 'work')
  const ui = await open($, 'session')
  expect(w.closes).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^Nothing tracked yet/ })).toBeDefined()
  await ui.unmount()
})

test('/board shows a pane that waits for room instead of closing it', async ($, on) => {
  const w = withWork()
  engine(on, w, NOW)
  await start($)
  w.panes = [{ id: 'board', title: 'Board', isShown: false, isFocused: false, isPlaced: false }]

  await board($, '')
  expect(w.closes).toEqual([])
  expect(w.opens).toContainEqual(expect.objectContaining({ id: 'board', focus: true }))
})

test('/board names the boards when asked for one that does not exist', async ($, on) => {
  engine(on, withWork(), NOW)
  await start($)

  const ran = await board($, 'nope')
  expect(ran.text).toBe('No board named nope. Boards: session, prs, review, work.')
})

test('/board clear empties the view on show, and a view with nothing to clear says so', async ($, on) => {
  engine(on, withWork(), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, goal: 'Something' })

  expect((await board($, 'session clear')).text).toBe('Session board cleared.')
  expect((await $.tool.call({ tool: TOOL })).result).toContain('goal: (none)')
  expect((await board($, 'work clear')).text).toBe('The work board has nothing to clear.')
})

test('an update opens the pane on its view, and once the person closes the pane updates leave it closed', async ($, on) => {
  const w = world()
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, goal: 'One' })
  expect(w.opens).toContainEqual(expect.objectContaining({ id: 'board' }))

  await board($, '')
  expect(w.closes).toContainEqual(expect.objectContaining({ id: 'board' }))
  w.opens.length = 0
  await $.tool.call({ tool: TOOL, goal: 'Two' })
  expect(w.opens).toEqual([])
})

test('a resumed session with a board opens the pane on it, and one with only file boards stays closed', async ($, on) => {
  const w = withWork()
  engine(on, w, NOW)
  await start($)
  expect(w.opens).toEqual([])

  await $.tool.call({ tool: TOOL, goal: 'Kept' })
  w.panes = []
  w.opens.length = 0
  w.session.id = 's2'
  await start($)
  expect(w.opens).toEqual([])
  w.session.id = 's1'
  await start($)
  expect(w.opens).toContainEqual(expect.objectContaining({ id: 'board' }))
})

test('the prompt says which board tools to keep current', async ($, on) => {
  engine(on, world(), NOW)
  on('prompt.compose', () => ({ sections: [] }))
  await start($)

  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [TOOL, 'mcp__board__prs'],
    outputStyle: null,
    traits: [],
  })
  const guide = composed.sections.find(s => s.id === 'board:guide')
  expect(guide?.text).toContain(TOOL)
  expect(guide?.text).toContain('mcp__board__prs')
})
