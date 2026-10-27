import { expect, test } from 'claude-code/testing'

import { board, CONFIG_FILE, engine, HOME, json, open, start, world } from './engine'
import { herdrHost, TREE, withLive, WORK_CONFIG, WORK_FILE } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'
const TIME_FILE = `${HOME}/.cache/board/time.json`
const at = (minutes: number) => new Date(NOW - 60 * 60_000 + minutes * 60_000).toISOString()
const transcript = (minutes: number[]) => minutes.map(m => json({ type: 'user', timestamp: at(m) })).join('\n')

test('a target inside two hours counts down in red, and inside a day in yellow', async ($, on) => {
  const items = [
    { id: 'soon', title: 'File the report', kind: 'Task', status: 'next', target: new Date(NOW + 90 * 60_000).toISOString() },
    { id: 'today', title: 'Send the draft', kind: 'Task', status: 'next', target: new Date(NOW + 10 * 3600e3).toISOString() },
  ]
  engine(on, world({ files: { [CONFIG_FILE]: json(WORK_CONFIG), [WORK_FILE]: json({ ...TREE, items }) } }), NOW)
  await start($)

  const ui = await open($, 'work')
  const colorOf = async (text: string) => (await ui.findAll({ type: 'Text' })).find(el => el.text === text)?.props.color
  expect(await colorOf('in 2h')).toBe('red')
  expect(await colorOf('in 10h')).toBe('yellow')
  await ui.unmount()
})

test("an Item's time is its sessions' active time, gaps over five minutes cut, summed up the tree with finished ones", async ($, on) => {
  const file = { ...TREE, links: [{ child: 'session:herdr:default/w4:p1', parent: 'file:fee', at: at(0) }] }
  const files = {
    // 2 + 2 + 1 minutes; the 16 minutes in between are cut
    [`${HOME}/.claude/projects/-home-test/h1.jsonl`]: transcript([0, 2, 4, 20, 21]),
    [TIME_FILE]: json({ sessions: { 'h-old': { at: NOW - 3600e3, activeMs: 3 * 3600e3, item: 'file:scope' } } }),
  }
  const w = withLive(file, herdrHost([{ id: 'w4:p1', label: 'fee-work', harnessId: 'h1' }]), files)
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'waside-file:pay', text: '3h' })).toBeDefined()
  await ui.press({ key: 'wtoggle-file:pay' })
  await ui.press({ key: 'wtoggle-file:gross' })
  expect(await ui.find({ key: 'waside-file:gross', text: '5m' })).toBeDefined()
  expect(await ui.find({ key: 'waside-file:fee', text: /^5m\s*$/ })).toBeDefined()
  expect(await ui.find({ key: 'waside-file:scope', text: '3h' })).toBeDefined()
  await ui.unmount()

  expect(JSON.parse(w.files[TIME_FILE] ?? '{}').sessions.h1).toMatchObject({ activeMs: 5 * 60_000, item: 'file:fee' })
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('file:fee #3 [Task, needs, 5m spent] Settle the fee account')
})

const PERIODS = [{ name: 'Q4 2026-27', start: '2026-11-01', end: '2027-01-31' }]
const DATED = {
  ...TREE,
  items: [
    { id: 'pay', title: 'Payments rework', kind: 'Project', status: 'flight' },
    { id: 'gross', title: 'Gross funding', kind: 'Workstream', parent: 'pay', status: 'flight', target: '2026-11-20' },
    { id: 'fee', ref: 3, title: 'Settle the fee account', kind: 'Task', parent: 'gross', status: 'needs' },
    { id: 'scope', ref: 4, title: 'Scope the split', kind: 'Task', parent: 'pay', status: 'flight', target: '2026-10-01' },
    { id: 'old', title: 'Old launch', kind: 'Project', status: 'flight', started: '2026-09-01' },
    { id: 'tooling', title: 'Tooling', kind: 'Responsibility', shape: 'responsibility', status: 'flight' },
  ],
}
const withPeriods = () =>
  world({
    files: {
      [CONFIG_FILE]: json({ boards: [{ ...WORK_CONFIG.boards[0], periods: PERIODS }] }),
      [WORK_FILE]: json(DATED),
    },
  })

test('a Period draws the Items dated in it, the undated work under them, their ancestors and every Responsibility', async ($, on) => {
  engine(on, withPeriods(), NOW)
  await start($)

  const ui = await open($, 'work Q4 2026-27')
  expect(await ui.find({ key: 'wperiod' })).toMatchObject({ props: { label: 'Period: Q4 2026-27 ▾' } })
  await ui.press({ key: 'wtoggle-file:pay' })
  await ui.press({ key: 'wtoggle-file:gross' })
  expect(await ui.find({ key: 'wrow-file:fee' })).toBeDefined()
  expect(await ui.find({ key: 'wrow-file:scope' })).toBeUndefined()
  expect(await ui.find({ key: 'wrow-file:old' })).toBeUndefined()
  expect(await ui.find({ key: 'wrow-file:tooling' })).toBeDefined()

  await ui.press({ key: 'wperiod' })
  expect(await ui.find({ key: 'wperiod-list' })).toMatchObject({ props: { position: 'absolute' } })
  await ui.press({ key: 'wper-all' })
  expect(await ui.find({ key: 'wperiod-list' })).toBeUndefined()
  expect(await ui.find({ key: 'wrow-file:old' })).toBeDefined()
  await ui.unmount()

  expect((await board($, 'work Q9')).text).toBe('No period Q9. Periods: Q4 2026-27, or all.')
})

test('marking an Item done stamps when it finished, and its first move off next when it started', async ($, on) => {
  const w = withPeriods()
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, add: [{ title: 'Write the doc', kind: 'Task', parent: 'pay' }] })
  await $.tool.call({ tool: TOOL, update: [{ id: 'write-the-doc', status: 'flight' }] })
  await $.tool.call({ tool: TOOL, update: [{ id: 'write-the-doc', status: 'done' }] })
  const doc = JSON.parse(w.files[WORK_FILE] ?? '{}').items.find((i: { id: string }) => i.id === 'write-the-doc')
  expect(doc).toMatchObject({ started: '2026-10-27T14:00:00.000Z', finished: '2026-10-27T14:00:00.000Z' })
})
