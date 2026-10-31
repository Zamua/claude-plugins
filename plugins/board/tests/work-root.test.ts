import { expect, test } from 'claude-code/testing'

import { engine, open, PANE, start } from './engine'
import { herdrHost, TREE, withLive } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'
// The session the tests run as, `s1`, sits in the herdr pane w4:p1
const SELF = { id: 'w4:p1', label: 'fee-work', harnessId: 's1' }
const SELF_ID = 'session:herdr:default/w4:p1'
const ROOT = { id: 'w1:p1', label: 'root', harnessId: 'h-root' }
const ROOT_ID = 'session:herdr:default/w1:p1'
const at = '2026-10-27T13:00:00Z'

test('a session matches an Item by the name of the herdr session it runs in', async ($, on) => {
  const review = { id: 'review', title: 'Code review', kind: 'Responsibility', shape: 'responsibility', aliases: ['reviews'] }
  const panes = [{ id: 'w2:p1', label: 'acme-api-8308', harnessId: 'h-r' }]
  engine(on, withLive({ ...TREE, items: [...TREE.items, review] }, herdrHost(panes, undefined, 'reviews')), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/file:review \[Responsibility, next\] Code review\n\s+session:herdr:reviews\/w2:p1 \[idle\] acme-api-8308/)
})

test('an attached session shows its path on one line above its board, and pressing it opens the work view there', async ($, on) => {
  const links = [{ child: SELF_ID, parent: 'file:fee', at }]
  engine(on, withLive({ ...TREE, links }, herdrHost([SELF])), NOW)
  await start($)

  const ui = await open($, 'session')
  expect(await ui.find({ key: 'crumbs', text: /Payments rework › Gross funding › Settle the fee account/ })).toBeDefined()
  expect(await ui.find({ key: 'crumbroot' })).toBeUndefined()
  await ui.press({ key: 'crumbopen' })
  expect(await ui.find({ key: 'wrow-file:fee', text: /Settle the fee/ })).toBeDefined()
  await ui.unmount()
})

test('a session with no Item and no root draws no breadcrumb', async ($, on) => {
  engine(on, withLive(TREE, herdrHost([SELF])), NOW)
  await start($)

  const ui = await open($, 'session')
  expect(await ui.find({ key: 'crumbs' })).toBeUndefined()
  await ui.unmount()
})

test('root: true makes this session the root, and root: false clears it', async ($, on) => {
  const w = withLive({ ...TREE, links: [{ child: SELF_ID, parent: 'file:fee', at }] }, herdrHost([SELF, ROOT]))
  engine(on, w, NOW)
  await start($)

  expect((await $.tool.call({ tool: TOOL, root: true })).result).toBe('Work updated.')
  expect(String((await $.tool.call({ tool: TOOL })).result)).toMatch(/^Root session: session:herdr:default\/w4:p1 \[idle\] fee-work/)
  expect((await $.tool.call({ tool: TOOL, root: false })).result).toBe('Work updated.')
  expect(String((await $.tool.call({ tool: TOOL })).result)).not.toContain('Root session')
})

test('every breadcrumb and work view starts with a root mark that brings the root session to the front', async ($, on) => {
  const links = [{ child: SELF_ID, parent: 'file:fee', at }]
  const w = withLive({ ...TREE, links, root: ROOT_ID }, herdrHost([SELF, ROOT]))
  engine(on, w, NOW)
  await start($)

  const crumbs = await open($, 'session')
  expect(await crumbs.find({ key: 'crumbroot', text: /⌂\s*root/ })).toBeDefined()
  await crumbs.unmount()
  const ui = await open($, 'work')
  expect(await ui.find({ key: 'whead', text: /⌂\s*root.*Updated 5m ago/ })).toBeDefined()
  await ui.press({ key: 'wroot' })
  expect(w.runs).toContainEqual(['herdr', '--session', 'default', 'workspace', 'focus', 'w1'])
  expect(await ui.find({ key: 'wunplaced' })).toBeUndefined()
  await ui.unmount()
  expect(String((await $.tool.call({ tool: TOOL })).result)).not.toContain('Unplaced sessions')
})

test('a root that has ended draws dim, and pressing it says it is not running', async ($, on) => {
  engine(on, withLive({ ...TREE, root: 'session:herdr:default/w99:p1' }, herdrHost([SELF])), NOW)
  await start($)

  const ui = await open($, 'work')
  expect((await ui.find({ key: 'wroot' }))?.children?.[0]).toMatchObject({ props: { dimColor: true } })
  await ui.press({ key: 'wroot' })
  expect(await ui.find({ type: 'Text', text: 'The root session is not running.' })).toBeDefined()
  await ui.unmount()
})

test("an attached session's work view first draws open down to its Item, with its own line marked", async ($, on) => {
  const links = [{ child: SELF_ID, parent: 'file:fee', at }]
  engine(on, withLive({ ...TREE, links }, herdrHost([SELF])), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wrow-file:fee' })).toBeDefined()
  expect(await ui.find({ key: `wsfocus-file:fee-${SELF_ID}`, text: /^● here idle\s+fee-work$/ })).toBeDefined()
  await ui.unmount()
})

test('a session started for an Item opens its pane on the work view, open down to that Item', async ($, on) => {
  const w = withLive(TREE, herdrHost([]))
  w.env['BOARD_WORK_ITEM'] = 'file:scope'
  engine(on, w, NOW)
  await start($)

  expect(w.opens).toContainEqual(expect.objectContaining({ id: 'board' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'wrow-file:scope', text: /Scope the split/ })).toBeDefined()
  await ui.unmount()
})
