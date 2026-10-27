import { expect, test } from 'claude-code/testing'

import { engine, open, start } from './engine'
import {
  herdrHost,
  prsBoard,
  sessionRecord,
  storeFile,
  trackedPr,
  TREE,
  withLive,
} from './work-fixtures'
import type { HerdrPane } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'

const withAliases = (links: unknown[] = []) => ({
  ...TREE,
  items: TREE.items.map(item => {
    if (item.id === 'gross') return { ...item, aliases: ['MM-809', 'split'] }
    if (item.id === 'fee') return { ...item, aliases: ['MM-809'] }
    if (item.id === 'scope') return { ...item, aliases: ['split'] }
    if (item.id === 'hostit') return { ...item, workspace: 'hostit' }
    if (item.id === 'old') return { ...item, aliases: ['launch'] }
    if (item.id === 'old-task') return { ...item, aliases: ['launch'] }
    return item
  }),
  links,
})

const PANES: HerdrPane[] = [
  { id: 'w1:p1', label: 'mm-809-crb-gross-funding', status: 'working', harnessId: 'h-fee' },
  { id: 'w2:p1', label: 'split-work', harnessId: 'h-split' },
  { id: 'w3:p1', label: 'hostit', status: 'blocked', harnessId: 'h-hostit' },
  { id: 'w4:p1', label: 'launch-notes', harnessId: 'h-launch' },
  { id: 'w5:p1', label: 'random', harnessId: 'h-random' },
  { id: 'w6:p1', label: 'notes', agent: '' },
]
const session = (pane: string) => `session:herdr:default/${pane}`

test('a session sits under the deepest unfinished Item its workspace name carries an alias of', async ($, on) => {
  engine(on, withLive(withAliases(), herdrHost(PANES)), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/file:fee #3 \[Task, needs\] Settle the fee account\n\s+session:herdr:default\/w1:p1 \[working\] mm-809-crb-gross-funding/)
  expect(read).toMatch(/file:hostit #6 \[Project, next\] hostit site list\n\s+session:herdr:default\/w3:p1 \[waiting\] hostit/)
  expect(read).toMatch(/file:old \[Project, done\] Old launch\n\s+session:herdr:default\/w4:p1 \[idle\] launch-notes/)
  expect(read).toMatch(/Unplaced sessions:\nsession:herdr:default\/w2:p1 \[idle\] split-work\nsession:herdr:default\/w5:p1 \[idle\] random/)
  expect(read).not.toContain('notes [')
})

test('a hand link beats an alias, and a session in no Item waits behind an unplaced count', async ($, on) => {
  const links = [{ child: session('w1:p1'), parent: 'file:scope', at: '2026-10-27T13:00:00Z' }]
  engine(on, withLive(withAliases(links), herdrHost(PANES)), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/file:scope #4 \[Task, flight\] Scope the split\n\s+session:herdr:default\/w1:p1/)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wunplaced', text: '▸ Unplaced 2 sessions' })).toBeDefined()
  expect(await ui.find({ key: 'wsess-unplaced-session:herdr:default/w5:p1' })).toBeUndefined()
  await ui.press({ key: 'wunplaced' })
  expect(await ui.find({ key: 'wsess-unplaced-session:herdr:default/w5:p1', text: /idle\s*random/ })).toBeDefined()
  await ui.unmount()
})

test("pressing an Item's session mark brings its most recently active session to the front", async ($, on) => {
  const panes = [...PANES, { id: 'w7:p1', label: 'mm-809-follow-up', status: 'blocked', harnessId: 'h-fee-2' }]
  const records = { ...sessionRecord(11, 'h-fee', 'zamua-11', NOW - 600_000), ...sessionRecord(12, 'h-fee-2', 'zamua-12', NOW - 60_000) }
  const w = withLive(withAliases(), herdrHost(panes), records)
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  await ui.press({ key: 'wtoggle-file:gross' })
  expect(await ui.find({ key: 'wmark-file:gross' })).toBeUndefined()
  expect(await ui.find({ key: 'wmark-file:fee', text: '●' })).toMatchObject({ children: [{ props: { color: 'warning' } }] })

  await ui.press({ key: 'wmark-file:fee' })
  expect(w.runs).toContainEqual(['herdr', '--session', 'default', 'workspace', 'focus', 'w7'])

  await ui.press({ key: 'wtoggle-file:fee' })
  expect(await ui.find({ key: 'wsess-file:fee-session:herdr:default/w1:p1', text: /working\s*mm-809-crb-gross-funding/ })).toBeDefined()
  await ui.unmount()
})

test('a session linked to its Coordinator draws beneath it once the Coordinator is opened', async ($, on) => {
  const links = [
    { child: session('w5:p1'), parent: 'file:pay', at: '2026-10-27T13:00:00Z' },
    { child: session('w1:p1'), parent: session('w5:p1'), at: '2026-10-27T13:00:00Z' },
  ]
  engine(on, withLive(withAliases(links), herdrHost(PANES)), NOW)
  await start($)

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  const coordinator = 'file:pay-session:herdr:default/w5:p1'
  expect(await ui.find({ key: `wsess-${coordinator}` })).toBeDefined()
  expect(await ui.find({ key: `wsess-session:herdr:default/w5:p1-session:herdr:default/w1:p1` })).toBeUndefined()
  await ui.press({ key: `wstoggle-${coordinator}` })
  expect(
    await ui.find({ key: 'wsess-session:herdr:default/w5:p1-session:herdr:default/w1:p1', text: /mm-809-crb-gross-funding/ }),
  ).toBeDefined()
  await ui.unmount()

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toContain('session:herdr:default/w1:p1 [working] mm-809-crb-gross-funding, coordinated by session:herdr:default/w5:p1')
})

test('a pull request some session tracks sits under the Item its title names, from cached facts alone', async ($, on) => {
  const held = prsBoard('s9', [
    trackedPr(7502, 'MM-809 adds the gross fee leg', { ci: 'fail', failing: ['build'] }),
    trackedPr(7503, 'Unrelated cleanup'),
    trackedPr(7400, 'Old merged work', { state: 'MERGED' }),
  ])
  const w = withLive(withAliases(), herdrHost([]), storeFile(held))
  engine(on, w, NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toContain('file:pay [Project, needs, 2 need you] Payments rework')
  expect(read).toMatch(/file:fee #3 \[Task, needs, 1 need you\] Settle the fee account\n\s+pr:acme\/api#7502 \[needs\] MM-809 adds the gross fee leg/)

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  await ui.press({ key: 'wtoggle-file:gross' })
  await ui.press({ key: 'wtoggle-file:fee' })
  expect(await ui.find({ key: 'wart-pr:acme/api#7502', text: /you\s*#7502\s*MM-809 adds the gross fee leg: CI failing: build/ })).toBeDefined()
  expect(await ui.find({ key: 'wunplaced', text: '▸ Unplaced 1 pull request' })).toBeDefined()
  await ui.unmount()
  expect(w.runs.some(argv => argv[0] === 'gh')).toBe(false)
})
