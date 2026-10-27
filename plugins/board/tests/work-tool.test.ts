import { expect, test } from 'claude-code/testing'

import { engine, HOME, open, start } from './engine'
import { TREE, withTree } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'
const WORK_FILE = `${HOME}/work.json`

type File = { items: { id: string; parent?: string; ref?: number; status?: string }[]; links: { child: string; parent: string }[] }
const fileOf = (files: Record<string, string>) => JSON.parse(files[WORK_FILE] ?? '{}') as File

test('a read lists every Item with its id, kind, rolled-up status and needs count', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toContain('file:pay [Project, needs, 1 need you] Payments rework')
  expect(read).toContain('    file:fee #3 [Task, needs] Settle the fee account')
  expect(read).toMatch(/Responsibilities:\nfile:tooling \[Responsibility, next\] Tooling/)
})

test('added Items get the next ref and appear under their parent', async ($, on) => {
  const w = withTree()
  engine(on, w, NOW)
  await start($)

  const added = await $.tool.call({ tool: TOOL, add: [{ title: 'Write the doc', kind: 'Task', parent: 'pay', status: 'next' }] })
  expect(added.result).toBe('Work updated. Added file:write-the-doc (#10).')
  expect(fileOf(w.files).items.find(i => i.id === 'write-the-doc')).toMatchObject({ parent: 'pay', ref: 10, status: 'next' })

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wrow-file:write-the-doc', text: /next\s*#10\s*Write the doc/ })).toBeDefined()
  await ui.unmount()
})

test('an update moves an Item, and a link sets a hand parent until it is unlinked', async ($, on) => {
  const w = withTree()
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, update: [{ id: 'fee', parent: 'pay', status: 'flight' }] })
  expect(fileOf(w.files).items.find(i => i.id === 'fee')).toMatchObject({ parent: 'pay', status: 'flight' })

  await $.tool.call({ tool: TOOL, link: [{ child: 'hostit', parent: 'pay' }] })
  expect(fileOf(w.files).links).toEqual([{ child: 'file:hostit', parent: 'file:pay', at: '2026-10-27T14:00:00.000Z' }])
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('  file:hostit #6 [Project, next] hostit site list')

  await $.tool.call({ tool: TOOL, unlink: ['hostit'] })
  expect(fileOf(w.files).links).toEqual([])
})

test('a change that names an unknown Item, edits another source, loops, or orphans children is refused whole', async ($, on) => {
  const w = withTree()
  engine(on, w, NOW)
  await start($)
  const before = w.files[WORK_FILE]

  const unknown = await $.tool.call({ tool: TOOL, add: [{ title: 'Kept out', kind: 'Task' }], update: [{ id: 'nope', status: 'done' }] })
  expect(unknown.deny).toContain('No Item nope')
  const foreign = await $.tool.call({ tool: TOOL, update: [{ id: 'linear:MM-1', status: 'done' }] })
  expect(foreign.deny).toContain('belongs to another source')
  const loop = await $.tool.call({ tool: TOOL, update: [{ id: 'pay', parent: 'fee' }] })
  expect(loop.deny).toContain('its own ancestor')
  const orphans = await $.tool.call({ tool: TOOL, remove: ['gross'] })
  expect(orphans.deny).toContain('still has children')
  const status = await $.tool.call({ tool: TOOL, update: [{ id: 'fee', status: 'later' }] })
  expect(status.deny).toContain('No status later')
  expect(w.files[WORK_FILE]).toBe(before)

  await $.tool.call({ tool: TOOL, remove: ['scope'] })
  expect(fileOf(w.files).items.map(i => i.id)).not.toContain('scope')
  expect(fileOf(w.files).items).toHaveLength(TREE.items.length - 1)
})
