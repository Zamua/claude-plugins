import { expect, test } from 'claude-code/testing'

import { engine, open, start } from './engine'
import { TREE, withTree } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')

test('a needs-you Item deep in the tree counts on its top line and stays folded until its ancestors open', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wtoggle-file:pay', text: '▸ you   Payments rework' })).toBeDefined()
  expect(await ui.find({ key: 'wfact-file:pay', text: /^\s*1\s*$/ })).toBeDefined()
  expect(await ui.find({ key: 'wrow-file:fee' })).toBeUndefined()
  expect(await ui.find({ key: 'tab-work', text: 'work 1' })).toBeDefined()

  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wrow-file:gross' })).toBeDefined()
  expect(await ui.find({ key: 'wrow-file:fee' })).toBeUndefined()
  await ui.press({ key: 'wtoggle-file:gross' })
  expect(await ui.find({ key: 'wrow-file:fee', text: /you\s*Settle the fee/ })).toBeDefined()

  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wrow-file:gross' })).toBeUndefined()
  await ui.unmount()
})

test('a title too long for its column is cut to fit, so its whole row stays one pressable line', async ($, on) => {
  const long = { ...TREE, items: [{ id: 'long', title: 'A project whose title runs on far past the width the pane has room for', kind: 'Project', status: 'next' }] }
  engine(on, withTree(long), NOW)
  await start($)

  const ui = await open($, 'work')
  const text = (await ui.find({ key: 'wtoggle-file:long' }))?.text ?? ''
  expect(text).toMatch(/^▸ next  A project whose title.*…$/)
  expect([...text].length).toBeLessThanOrEqual(58)
  await ui.unmount()
})

test('a pressed Item opens to its links and children alone, and ongoing work sorts into the one list after what needs the person', async ($, on) => {
  const linked = { ...TREE, items: TREE.items.map(item => (item.id === 'pay' ? { ...item, links: [{ label: 'Spec', url: 'https://example.com/spec' }] } : item)) }
  engine(on, withTree(linked), NOW)
  await start($)

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wlink-file:pay-0', text: '↗ Spec' })).toBeDefined()
  expect(await ui.find({ key: 'wrow-file:scope' })).toBeDefined()
  await ui.press({ key: 'wtoggle-file:scope' })
  expect(await ui.find({ key: 'wmore-file:scope' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Project|#4/ })).toBeUndefined()

  expect(await ui.find({ key: 'top', text: /Payments rework.*Tooling/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(Outcomes|Responsibilities)$/ })).toBeUndefined()
  await ui.unmount()
})

test('an Outcome whose work is all done folds behind a done count, and the freshness sits top right', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wrow-file:old' })).toBeUndefined()
  expect(await ui.find({ key: 'wdone-top' })).toMatchObject({ props: { label: '✓ 1 done' } })
  await ui.press({ key: 'wdone-top' })
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
