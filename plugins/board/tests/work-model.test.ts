import { expect, test } from 'claude-code/testing'

import { engine, open, start } from './engine'
import { TREE, withTree } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')

test('a needs-you Item deep in the tree counts on its top line and stays folded until its ancestors open', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wtoggle-file:pay', text: '▸ you   1 Project Payments rework' })).toBeDefined()
  expect(await ui.find({ key: 'wrow-file:fee' })).toBeUndefined()
  expect(await ui.find({ key: 'tab-work', text: 'work 1' })).toBeDefined()

  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wrow-file:gross' })).toBeDefined()
  expect(await ui.find({ key: 'wrow-file:fee' })).toBeUndefined()
  await ui.press({ key: 'wtoggle-file:gross' })
  expect(await ui.find({ key: 'wrow-file:fee', text: /you\s*#3\s*Settle the fee account/ })).toBeDefined()

  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wrow-file:gross' })).toBeUndefined()
  await ui.unmount()
})

test('a title too long for the pane is cut to fit, so its whole row stays one pressable line', async ($, on) => {
  const long = { ...TREE, items: [{ id: 'long', title: 'A project whose title runs on far past the width the pane has room for', kind: 'Project', status: 'next', detail: 'More.' }] }
  engine(on, withTree(long), NOW)
  await start($)

  const ui = await open($, 'work')
  const text = (await ui.find({ key: 'wtoggle-file:long' }))?.text ?? ''
  expect(text).toMatch(/^▸ next  Project A project whose title runs on .*…$/)
  expect([...text].length).toBeLessThanOrEqual(59)
  await ui.press({ key: 'wtoggle-file:long' })
  expect(await ui.find({ type: 'Markdown', text: 'More.' })).toBeDefined()
  await ui.unmount()
})

test('a leaf opens to its detail, and Responsibilities draw after the Outcomes', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  await ui.press({ key: 'wtoggle-file:scope' })
  expect(await ui.find({ type: 'Markdown', text: 'Against **main**.' })).toBeDefined()

  expect(await ui.find({ key: 'responsibilities', text: /^Responsibilities.*Tooling/ })).toBeDefined()
  expect(await ui.find({ key: 'responsibilities', text: /Payments/ })).toBeUndefined()
  await ui.unmount()
})

test('an Outcome whose work is all done folds behind a done count, and the freshness sits top right', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wrow-file:old' })).toBeUndefined()
  expect(await ui.find({ key: 'wdone-top-outcomes' })).toMatchObject({ props: { label: '✓ 1 done' } })
  await ui.press({ key: 'wdone-top-outcomes' })
  expect(await ui.find({ key: 'wrow-file:old', text: /done/ })).toBeDefined()
  expect(await ui.find({ key: 'stamp', text: 'Updated 5m ago' })).toBeDefined()
  await ui.unmount()
})

test('an Item whose parent would make a cycle sits at the top with a warning', async ($, on) => {
  const looped = {
    ...TREE,
    items: [...TREE.items.filter(i => i.id !== 'pay'), { id: 'pay', title: 'Payments rework', kind: 'Project', parent: 'fee' }],
  }
  engine(on, withTree(looped), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wrow-file:gross' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Gross funding sits at the top: its parent would make a cycle.' })).toBeDefined()
  await ui.unmount()
})

test('a board still in the old format says to migrate', async ($, on) => {
  engine(on, withTree({ groups: [{ id: 'pay' }], items: [] }), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ type: 'Text', text: /old format.*\/board work migrate/ })).toBeDefined()
  await ui.unmount()
})
