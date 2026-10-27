import { expect, test } from 'claude-code/testing'

import { board, CONFIG_FILE, engine, HOME, json, open, start, world } from './engine'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const WORK_FILE = `${HOME}/work.json`
const BACKUP = `${HOME}/work.v1.json`
const CONFIG = { boards: [{ id: 'work', layout: 'model', path: '~/work.json' }] }

const V1 = {
  updated_at: '2026-10-26T19:40:50Z',
  next_ref: 49,
  groups: [
    { id: 'pay', title: 'Payments rework', source: 'https://linear.app/acme/project/pay', source_label: 'Linear' },
    { id: 'pay-gross', parent: 'pay', title: 'Gross', links: [{ label: 'SDD', url: 'https://notion.so/sdd' }] },
    { id: 'tooling', title: 'Tooling' },
  ],
  items: [
    { id: 'scope', ref: 1, group: 'pay', section: 'needs', title: 'Scope the split', links: [{ label: 'api#1', url: 'https://github.com/acme/api/pull/1' }] },
    { id: 'gross', ref: 2, group: 'pay-gross', section: 'flight', title: 'Gross funding', workspace: 'ac-809-gross', due: '2026-10-28T20:00:00Z', due_label: 'review' },
    { id: 'fee', ref: 12, group: 'pay-gross', section: 'done', title: 'Fee settled', detail: 'Settled in **MT**.' },
    { id: 'hostit', ref: 48, group: 'tooling', section: 'waiting', title: 'hostit site list' },
    { id: 'stray', ref: 30, group: 'gone', section: 'next', title: 'Stray item' },
  ],
}

const migrated = (files: Record<string, string>) =>
  JSON.parse(files[WORK_FILE] ?? '{}') as { version: number; next_ref: number; items: Record<string, unknown>[] }

test('migrating keeps every group and item, saves the old board beside it, and reports what it could not place', async ($, on) => {
  const w = world({ files: { [CONFIG_FILE]: json(CONFIG), [WORK_FILE]: json(V1) } })
  engine(on, w, NOW)
  await start($)

  const reply = await board($, 'work migrate')
  expect(reply.text).toContain('3 groups and 5 items became 8 Items')
  expect(reply.text).toContain('Stray item: no group gone')
  expect(w.files[BACKUP]).toBe(json(V1))

  const file = migrated(w.files)
  expect(file.version).toBe(2)
  expect(file.next_ref).toBe(49)
  const byId = new Map(file.items.map(item => [item.id, item]))
  expect(byId.get('tooling')).toMatchObject({ kind: 'Responsibility', shape: 'responsibility' })
  expect(byId.get('pay')).toMatchObject({ kind: 'Project', source: 'https://linear.app/acme/project/pay' })
  expect(byId.get('pay-gross')).toMatchObject({ parent: 'pay', links: [{ label: 'SDD', url: 'https://notion.so/sdd' }] })
  expect(byId.get('gross')).toMatchObject({
    kind: 'Task',
    parent: 'pay-gross',
    status: 'flight',
    ref: 2,
    target: '2026-10-28T20:00:00Z',
    target_label: 'review',
    workspace: 'ac-809-gross',
  })
  expect(byId.get('fee')).toMatchObject({ status: 'done', detail: 'Settled in **MT**.' })
  expect(byId.get('hostit')).toMatchObject({ status: 'waiting', parent: 'tooling' })
  expect(byId.get('stray')?.parent).toBeUndefined()

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wrow-file:pay', text: /you\s*1\s*Project\s*Payments rework/ })).toBeDefined()
  expect(await ui.find({ key: 'wrow-file:stray' })).toBeDefined()
  await ui.unmount()
})

test('a board already migrated is left alone', async ($, on) => {
  const w = world({ files: { [CONFIG_FILE]: json(CONFIG), [WORK_FILE]: json(V1) } })
  engine(on, w, NOW)
  await start($)
  await board($, 'work migrate')
  const after = w.files[WORK_FILE]

  const again = await board($, 'work migrate')
  expect(again.text).toContain('already version 2')
  expect(w.files[WORK_FILE]).toBe(after)
})
