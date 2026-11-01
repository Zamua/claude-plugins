import { expect, test } from 'claude-code/testing'

import { engine, open, start } from './engine'
import { herdrHost, TREE, withLive } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'
const at = '2026-10-27T13:00:00Z'
// The tests run as `s1`, the root session in w1:p1
const ROOT = { id: 'w1:p1', label: 'root', harnessId: 's1' }
const ROOT_ID = 'session:herdr:default/w1:p1'
const ASKER = { id: 'w2:p1', label: 'fee-route', harnessId: 'h2', status: 'blocked' }

const ASKS = {
  ...TREE,
  root: ROOT_ID,
  links: [{ child: 'session:herdr:default/w2:p1', parent: 'file:route', at }],
  items: [
    ...TREE.items,
    {
      id: 'route',
      ref: 7,
      title: 'Pick the fee route',
      kind: 'Decision',
      parent: 'gross',
      status: 'needs',
      started: '2026-10-27T12:00:00Z',
      detail: 'Options: the reserve account or the merchant. Recommend the reserve account.',
    },
    { id: 'plan', ref: 8, title: 'Approve the hostit plan', kind: 'Decision', parent: 'tooling', status: 'needs', target: '2026-10-28T12:00:00Z' },
  ],
}

test("the root's decisions view lists every ask, one blocking a session first, then the nearest due, and opens to its options", async ($, on) => {
  const w = withLive(ASKS, herdrHost([ROOT, ASKER]))
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'decisions')
  expect(await ui.find({ key: 'tab-decisions', text: 'decisions 3' })).toBeDefined()
  expect(await ui.find({ key: 'decisions', text: /Pick the fee route.*Approve the hostit plan.*Settle the fee account/ })).toBeDefined()
  expect(await ui.find({ key: 'drow-file:route', text: /^▸ Pick the fee route\s+fee-route\s+2h$/ })).toBeDefined()
  expect(await ui.find({ key: 'drow-file:plan', text: /Approve the hostit plan\s+in 22h/ })).toBeDefined()

  await ui.press({ key: 'dtoggle-file:route' })
  expect(await ui.find({ key: 'dmore-file:route', text: /Recommend the reserve account.*→ fee-route/ })).toBeDefined()
  await ui.press({ key: 'dfocus-file:route' })
  expect(w.runs).toContainEqual(['herdr', '--session', 'default', 'workspace', 'focus', 'w2'])
  await ui.unmount()
})

test('an answer marks the ask done, and it leaves the list for the answered fold', async ($, on) => {
  engine(on, withLive(ASKS, herdrHost([ROOT, ASKER])), NOW)
  await start($)

  expect((await $.tool.call({ tool: TOOL, update: [{ id: 'route', answer: 'The reserve account' }] })).result).toBe('Work updated.')
  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/file:route #7 \[Decision, done\] Pick the fee route\n\s+answer: The reserve account/)

  const ui = await open($, 'decisions')
  expect(await ui.find({ key: 'tab-decisions', text: 'decisions 2' })).toBeDefined()
  expect(await ui.find({ key: 'drow-file:route' })).toBeUndefined()
  await ui.press({ key: 'dansweredtoggle' })
  await ui.press({ key: 'dtoggle-file:route' })
  expect(await ui.find({ key: 'dmore-file:route', text: /^Answer: The reserve account/ })).toBeDefined()
  await ui.unmount()
})

test('a session that is not the root has no decisions view', async ($, on) => {
  engine(on, withLive({ ...ASKS, root: 'session:herdr:default/w9:p1' }, herdrHost([ROOT, ASKER])), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'tab-decisions' })).toBeUndefined()
  await ui.unmount()
})
