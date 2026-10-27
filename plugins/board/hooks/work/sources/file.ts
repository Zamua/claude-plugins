import type { EngineInterface } from 'claude-code'

import type { JsonFile } from '../../kit'
import { ORIGINS, qualify, URGENCY } from '../model'
import type { Item, ItemLink, Link, Origin, Shape, Status } from '../model'

/** One Item as the local file keeps it: ids without the `file:` prefix, and any field another writer added. */
export type LocalItem = {
  id: string
  title: string
  kind: string
  shape?: Shape
  status?: Status
  parent?: string
  origin?: Origin
  target?: string
  target_label?: string
  started?: string
  finished?: string
  detail?: string
  links?: ItemLink[]
  aliases?: string[]
  ref?: number
  workspace?: string
  source?: string
  source_label?: string
  [field: string]: unknown
}

export type LocalFile = {
  version: 2
  updated_at?: string
  next_ref?: number
  items: LocalItem[]
  links: Link[]
  [field: string]: unknown
}

/** What the file Source has read: the file, or why there is none. */
export type LocalState = JsonFile<unknown>

export const isLocal = (id: string) => !id.includes(':') || id.startsWith('file:')
export const localId = (id: string) => (id.startsWith('file:') ? id.slice('file:'.length) : id)

export function isVersion2(value: unknown): value is LocalFile {
  const file = value as LocalFile | undefined

  return file?.version === 2 && Array.isArray(file.items)
}

const asStatus = (value: unknown): Status => (URGENCY.includes(value as Status) ? (value as Status) : 'next')

const asOrigin = (value: unknown): Origin | undefined => {
  const origin = value as Origin | undefined

  return origin && ORIGINS.includes(origin.type) ? origin : undefined
}

const linksOf = (item: LocalItem): ItemLink[] => {
  const links = (Array.isArray(item.links) ? item.links : []).filter(one => one && typeof one.url === 'string')

  return item.source ? [{ url: item.source, label: item.source_label }, ...links.filter(l => l.url !== item.source)] : links
}

export function toItem(local: LocalItem): Item {
  const shape: Shape = local.shape === 'responsibility' ? 'responsibility' : 'outcome'

  return {
    id: qualify(local.id),
    source: 'file',
    kind: local.kind || 'Item',
    title: local.title || local.id,
    shape,
    status: asStatus(local.status),
    origin: asOrigin(local.origin),
    parent: local.parent ? qualify(local.parent) : undefined,
    aliases: Array.isArray(local.aliases) ? local.aliases.filter(a => typeof a === 'string') : [],
    target: shape === 'outcome' && typeof local.target === 'string' ? local.target : undefined,
    targetLabel: typeof local.target_label === 'string' ? local.target_label : undefined,
    started: local.started,
    finished: local.finished,
    detail: local.detail,
    links: linksOf(local),
    ref: Number.isInteger(local.ref) ? local.ref : undefined,
    workspace: typeof local.workspace === 'string' ? local.workspace : undefined,
  }
}

const linkOf = (link: Link): Link => ({ ...link, child: qualify(link.child), parent: qualify(link.parent) })

export function itemsAndLinks(file: LocalFile): { items: Item[]; links: Link[] } {
  return {
    items: file.items.filter(item => item && typeof item.id === 'string').map(toItem),
    links: (Array.isArray(file.links) ? file.links : []).filter(l => l && l.child && l.parent).map(linkOf),
  }
}

/** The file as it is on disk now, for a change that must not overwrite another session's. */
export async function readLocalNow($: EngineInterface, path: string): Promise<LocalFile> {
  if (!(await $.fs.exists(path))) return { version: 2, items: [], links: [] }
  const value: unknown = JSON.parse(await $.fs.read(path))
  if (!isVersion2(value)) throw new Error('The work board is in the old format; run /board work migrate first.')

  return { ...value, links: Array.isArray(value.links) ? value.links : [] }
}

export async function writeLocal($: EngineInterface, state: LocalState, path: string, file: LocalFile) {
  const stamped = { ...file, updated_at: new Date(await $.clock.now()).toISOString() }
  await $.fs.write(path, `${JSON.stringify(stamped, null, 2)}\n`)
  state.value = stamped
  state.error = undefined
  state.isMissing = false
  // The next refresh rereads it, since a rewrite of the same length may keep the mtime the poll compares
  state.mtime = undefined
}
