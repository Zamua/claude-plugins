import type { EngineInterface } from 'claude-code'

import { URGENCY } from './model'
import type { Status } from './model'
import { isVersion2 } from './sources/file'
import type { LocalFile, LocalItem } from './sources/file'

type V1Group = { id: string; parent?: string; title?: string; [field: string]: unknown }
type V1Item = { id: string; group?: string; section?: string; title: string; due?: string; due_label?: string; [field: string]: unknown }
type V1 = { updated_at?: string; next_ref?: number; groups?: V1Group[]; items?: V1Item[]; [field: string]: unknown }

export type MigrationReport = { groups: number; items: number; written: number; unplaced: string[] }

/** Groups that are standing responsibilities rather than projects with an end. */
const RESPONSIBILITIES = new Set(['tooling'])

// The work board drew an item with an unknown section as done
const statusOf = (section: unknown): Status => (URGENCY.includes(section as Status) ? (section as Status) : 'done')

export function migrateV1(v1: V1): { file: LocalFile; report: MigrationReport } {
  const groups = (Array.isArray(v1.groups) ? v1.groups : []).filter(g => g && typeof g.id === 'string')
  const items = (Array.isArray(v1.items) ? v1.items : []).filter(i => i && typeof i.id === 'string')
  const known = new Set(groups.map(g => g.id))
  const unplaced: string[] = []
  const out: LocalItem[] = []

  for (const group of groups) {
    const { id, parent, title, ...rest } = group
    const isResponsibility = RESPONSIBILITIES.has(id)
    const hasParent = typeof parent === 'string' && known.has(parent) && parent !== id
    if (parent && !hasParent) unplaced.push(`group ${title ?? id}: no group ${parent}`)
    out.push({
      ...rest,
      id,
      title: title || id,
      kind: isResponsibility ? 'Responsibility' : 'Project',
      shape: isResponsibility ? 'responsibility' : 'outcome',
      status: 'flight',
      ...(hasParent ? { parent } : {}),
    })
  }

  const taken = new Set(out.map(item => item.id))
  for (const item of items) {
    const { id, group, section, due, due_label, ...rest } = item
    const free = taken.has(id) ? `${id}-item` : id
    if (free !== id) unplaced.push(`item ${item.title}: id ${id} renamed ${free}, a group has it`)
    taken.add(free)
    const hasParent = typeof group === 'string' && known.has(group)
    if (!hasParent) unplaced.push(`item ${item.title}: no group ${group ?? '(none)'}`)
    out.push({
      ...rest,
      id: free,
      title: item.title,
      kind: 'Task',
      status: statusOf(section),
      ...(hasParent ? { parent: group } : {}),
      ...(typeof due === 'string' ? { target: due } : {}),
      ...(typeof due_label === 'string' ? { target_label: due_label } : {}),
    })
  }

  const { groups: _groups, items: _items, ...kept } = v1
  const file: LocalFile = { ...kept, version: 2, items: out, links: [] }

  return { file, report: { groups: groups.length, items: items.length, written: out.length, unplaced } }
}

export const backupPath = (path: string) => path.replace(/(\.json)?$/, '.v1.json')

/** Rewrites a version 1 board as version 2, after saving the original beside it. */
export async function migrateFile($: EngineInterface, path: string): Promise<MigrationReport> {
  if (!(await $.fs.exists(path))) throw new Error(`No board at ${path}.`)
  const text = await $.fs.read(path)
  const value: unknown = JSON.parse(text)
  if (isVersion2(value)) throw new Error('The work board is already version 2.')
  const backup = backupPath(path)
  if (await $.fs.exists(backup)) throw new Error(`${backup} already exists; move it before migrating again.`)
  const { file, report } = migrateV1(value as V1)
  await $.fs.write(backup, text)
  await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)

  return report
}

export function reportText(report: MigrationReport, path: string): string {
  const lines = [
    `Migrated ${path}: ${report.groups} groups and ${report.items} items became ${report.written} Items.`,
    `The old board is saved at ${backupPath(path)}.`,
  ]
  if (report.unplaced.length > 0) lines.push('Placed at the top level:', ...report.unplaced.map(one => `- ${one}`))

  return lines.join('\n')
}
