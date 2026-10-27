import { CONFIG_FILE, HOME, json, world } from './engine'

export const WORK_FILE = `${HOME}/work.json`
export const WORK_CONFIG = { boards: [{ id: 'work', layout: 'model', path: '~/work.json' }] }

export const TREE = {
  version: 2,
  updated_at: '2026-10-27T13:55:00Z',
  next_ref: 10,
  items: [
    { id: 'pay', title: 'Payments rework', kind: 'Project', status: 'flight' },
    { id: 'gross', title: 'Gross funding', kind: 'Workstream', parent: 'pay', status: 'flight' },
    { id: 'fee', ref: 3, title: 'Settle the fee account', kind: 'Task', parent: 'gross', status: 'needs' },
    { id: 'scope', ref: 4, title: 'Scope the split', kind: 'Task', parent: 'pay', status: 'flight', detail: 'Against **main**.' },
    { id: 'old', title: 'Old launch', kind: 'Project', status: 'flight' },
    { id: 'old-task', ref: 5, title: 'Shipped it', kind: 'Task', parent: 'old', status: 'done' },
    { id: 'tooling', title: 'Tooling', kind: 'Responsibility', shape: 'responsibility', status: 'flight' },
    { id: 'hostit', ref: 6, title: 'hostit site list', kind: 'Project', parent: 'tooling', status: 'next' },
  ],
  links: [],
}

export const withTree = (file: unknown = TREE) =>
  world({ files: { [CONFIG_FILE]: json(WORK_CONFIG), [WORK_FILE]: json(file) } })
