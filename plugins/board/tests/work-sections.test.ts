import { expect, test } from 'claude-code/testing'

import { engine, HOME, json, open, start } from './engine'
import { herdrHost, prsBoard, storeFile, TREE, trackedPr, withLive, withTree } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'

test('named sections group the top level in order, with an Item put in none in the last and an empty one left out', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  await $.tool.call({
    tool: TOOL,
    sections: ['Goals', 'Side', 'Empty', 'Misc'],
    update: [
      { id: 'pay', section: 'Goals' },
      { id: 'tooling', section: 'Side' },
    ],
  })
  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/Goals:\nfile:pay [^\n]*\n(  .*\n)*Side:\nfile:tooling [^\n]*\n(  .*\n)*Misc:\nfile:old /)
  expect(read).not.toContain('Empty:')

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wsec-goals', text: /^Goals▸ you\s+Payments rework/ })).toBeDefined()
  expect(await ui.find({ key: 'wsec-side', text: /^Side▸ next\s+Tooling/ })).toBeDefined()
  expect(await ui.find({ key: 'wsec-misc', text: 'Misc✓ 1 done' })).toBeDefined()
  expect(await ui.find({ key: 'wsec-empty' })).toBeUndefined()
  await ui.unmount()
})

test('an Item cannot be put in a section that is not named, and the refusal names the ones there are', async ($, on) => {
  engine(on, withTree({ ...TREE, sections: ['Goals', 'Misc'] }), NOW)
  await start($)

  const refused = await $.tool.call({ tool: TOOL, update: [{ id: 'pay', section: 'Work' }] })
  expect(refused.deny).toBe('No section Work. The sections are Goals, Misc; set them with sections.')
})

test('a hidden pull request leaves the tree, a hidden Item takes its children with it, and unhide brings one back', async ($, on) => {
  const file = { ...TREE, items: TREE.items.map(item => (item.id === 'fee' ? { ...item, aliases: ['ABC-809'] } : item)) }
  const held = prsBoard('s9', [trackedPr(7600, 'ABC-809 adds the fee lookup', { author: 'lee' })])
  const cache = { [`${HOME}/.cache/board/github.json`]: json({ prs: {}, viewer: 'me' }) }
  engine(on, withLive(file, herdrHost([]), { ...storeFile(held), ...cache }), NOW)
  await start($)
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('pr:acme/api#7600 [watching]')

  await $.tool.call({ tool: TOOL, hide: ['pr:acme/api#7600', 'old'] })
  const hidden = String((await $.tool.call({ tool: TOOL })).result)
  expect(hidden).not.toContain('pr:acme/api#7600 [')
  expect(hidden).not.toContain('file:old-task')
  expect(hidden).toContain('Hidden: pr:acme/api#7600, file:old')

  await $.tool.call({ tool: TOOL, unhide: ['pr:acme/api#7600'] })
  const back = String((await $.tool.call({ tool: TOOL })).result)
  expect(back).toContain('pr:acme/api#7600 [watching]')
  expect(back).toContain('Hidden: file:old')
  expect((await $.tool.call({ tool: TOOL, unhide: ['scope'] })).deny).toBe('scope is not hidden.')
})
