import type { EngineInterface, On } from 'claude-code'

import { messageOf } from '../kit'
import { buildTree, ORIGINS, qualify, treeText, URGENCY } from './model'
import type { ItemLink, Origin, Shape, Status } from './model'
import { isLocal, itemsAndLinks, localId, readLocalNow, writeLocal } from './sources/file'
import type { LocalFile, LocalItem } from './sources/file'
import { currentWork, WORK_TOOL, workTree } from './view'

const DESCRIPTION = `Read and change the work view of the board pane: one tree of everything the person works on, from their goals down to tasks, with responsibilities such as on-call or tooling beside them. Items nest to any depth; each has a kind (the person's own name for its level, such as Project or Task) and a status: needs (needs the person), flight (in flight), waiting, next, watching, done.
- Call with no fields to read the tree with every Item's id.
- add: new Items, each with a title and a kind, under a parent by id. A responsibility (shape: responsibility) never ends.
- update: change an Item's fields, including parent to move it. Mark finished work status done rather than removing it.
- remove: delete Items that have no children.
- link / unlink: set or clear a hand-set parent for any Item, which wins over the parent its source gives.
Only Items whose ids start with file: (or have no prefix) can be added, updated or removed; Items from other sources can only be linked. The changes apply together, or none do. Keep titles to one short line.`

const STATUS_ENUM = [...URGENCY]
const ITEM_FIELDS = {
  title: { type: 'string' },
  kind: { type: 'string', description: 'The level name, such as Project or Task.' },
  parent: { type: 'string', description: 'The parent Item id.' },
  shape: { type: 'string', enum: ['outcome', 'responsibility'] },
  status: { type: 'string', enum: STATUS_ENUM },
  origin: {
    type: 'object',
    properties: { type: { type: 'string', enum: [...ORIGINS] }, by: { type: 'string' } },
    required: ['type'],
  },
  target: { type: 'string', description: 'The deadline, as an ISO date or time.' },
  detail: { type: 'string', description: 'Markdown shown when the Item is pressed open.' },
  links: {
    type: 'array',
    items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['url'] },
  },
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    add: { type: 'array', items: { type: 'object', properties: ITEM_FIELDS, required: ['title', 'kind'] } },
    update: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, ...ITEM_FIELDS }, required: ['id'] } },
    remove: { type: 'array', items: { type: 'string' } },
    link: {
      type: 'array',
      items: { type: 'object', properties: { child: { type: 'string' }, parent: { type: 'string' } }, required: ['child', 'parent'] },
    },
    unlink: { type: 'array', items: { type: 'string' } },
  },
}

type Fields = {
  title?: string
  kind?: string
  parent?: string
  shape?: Shape
  status?: Status
  origin?: Origin
  target?: string
  detail?: string
  links?: ItemLink[]
}
type Input = {
  add?: (Fields & { title: string; kind: string })[]
  update?: (Fields & { id: string })[]
  remove?: string[]
  link?: { child: string; parent: string }[]
  unlink?: string[]
}

type Applied = { file: LocalFile; added: string[] } | { error: string }

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'item'

// A session or pull request is not an Item, so it can be linked before any Source has seen it
const isExternalChild = (id: string) => id.startsWith('session:') || id.startsWith('pr:')

function checkFields(fields: Fields): string | undefined {
  if (fields.status !== undefined && !URGENCY.includes(fields.status)) return `No status ${fields.status}.`
  if (fields.shape !== undefined && fields.shape !== 'outcome' && fields.shape !== 'responsibility') return `No shape ${fields.shape}.`
  if (fields.origin !== undefined && !ORIGINS.includes(fields.origin.type)) return `No origin ${fields.origin.type}.`

  return undefined
}

const patch = (item: LocalItem, fields: Fields): LocalItem => {
  const next: LocalItem = { ...item }
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && key !== 'id') next[key] = value
  if (fields.parent !== undefined) next.parent = localId(fields.parent)

  return next
}

/** `others` holds the ids of Items other Sources have, which local Items and links may sit under. */
export function applyChange(current: LocalFile, input: Input, now: string, others: ReadonlySet<string> = new Set()): Applied {
  let items = [...current.items]
  let links = [...current.links]
  let nextRef = current.next_ref ?? Math.max(0, ...items.map(i => i.ref ?? 0)) + 1
  const ids = new Set(items.map(i => i.id))
  const added: string[] = []
  const before = buildTree(itemsAndLinks(current).items, itemsAndLinks(current).links)

  for (const id of [...(input.update ?? []).map(u => u.id), ...(input.remove ?? [])]) {
    if (!isLocal(id)) return { error: `${id} belongs to another source; only link can change where it sits.` }
    if (!ids.has(localId(id))) return { error: `No Item ${id}. Call with no fields to list the ids.` }
  }
  for (const fields of [...(input.add ?? []), ...(input.update ?? [])]) {
    const wrong = checkFields(fields)
    if (wrong) return { error: wrong }
  }

  for (const one of input.add ?? []) {
    if (!one.title?.trim() || !one.kind?.trim()) return { error: 'Each added Item needs a title and a kind.' }
    let id = slug(one.title)
    for (let n = 2; ids.has(id); n++) id = `${slug(one.title)}-${n}`
    ids.add(id)
    items.push(patch({ id, title: one.title.trim(), kind: one.kind.trim(), status: 'next', ref: nextRef }, one))
    added.push(`file:${id} (#${nextRef})`)
    nextRef += 1
  }
  for (const one of input.update ?? []) {
    items = items.map(item => (item.id === localId(one.id) ? patch(item, one) : item))
  }
  for (const id of input.remove ?? []) {
    const local = localId(id)
    const hasChildren =
      items.some(item => item.parent === local) || links.some(link => qualify(link.parent) === qualify(local))
    if (hasChildren) return { error: `${id} still has children; move or remove them first.` }
    items = items.filter(item => item.id !== local)
    links = links.filter(link => qualify(link.child) !== qualify(local))
  }
  for (const id of input.unlink ?? []) {
    if (!links.some(link => qualify(link.child) === qualify(id))) return { error: `${id} has no hand-set parent.` }
    links = links.filter(link => qualify(link.child) !== qualify(id))
  }
  const changed: LocalFile = { ...current, items, links, next_ref: nextRef }
  const known = new Set([...others, ...buildTree(itemsAndLinks(changed).items, []).byId.keys()])
  for (const one of input.link ?? []) {
    const child = qualify(one.child)
    const parent = qualify(one.parent)
    if (!known.has(child) && !isExternalChild(child)) return { error: `No Item ${one.child}.` }
    if (!known.has(parent) && !parent.startsWith('session:')) return { error: `No Item ${one.parent}.` }
    links = [...links.filter(link => qualify(link.child) !== child), { child, parent, at: now }]
  }

  const result: LocalFile = { ...changed, links }
  const after = buildTree(itemsAndLinks(result).items, itemsAndLinks(result).links)
  const looped = after.cycles.find(id => !before.cycles.includes(id))
  if (looped) return { error: `That change would make ${looped} its own ancestor.` }
  for (const item of items) {
    const parent = item.parent ? qualify(item.parent) : undefined
    if (parent && !after.byId.has(parent) && !others.has(parent)) return { error: `No Item ${item.parent} to sit under.` }
  }

  return { file: result, added }
}

export function workHooks(on: On) {
  on('tool.check', { tool: WORK_TOOL }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: WORK_TOOL }, async ($, e) => {
    const w = currentWork()
    if (!w) return { deny: 'No work board is configured: add a board with layout "model" to ~/.config/board/boards.json.' }
    const { tool, tool_use_id, consent, agentId, ...args } = e
    const input = args as Input
    const isRead = !input.add?.length && !input.update?.length && !input.remove?.length && !input.link?.length && !input.unlink?.length
    let current: LocalFile
    try {
      current = await readLocalNow($, w.path)
    } catch (err) {
      return { deny: messageOf(err) }
    }
    if (isRead) {
      const { tree } = workTree(current)
      return { result: tree ? treeText(tree) : 'The work board is empty.' }
    }
    const applied = applyChange(current, input, new Date(await $.clock.now()).toISOString())
    if ('error' in applied) return { deny: applied.error }
    await writeLocal($, w.state, w.path, applied.file)
    $.ui.invalidate('ui.render')

    return { result: applied.added.length > 0 ? `Work updated. Added ${applied.added.join(', ')}.` : 'Work updated.' }
  })
}

export async function workToolStart($: EngineInterface) {
  await $.tool.register({ name: 'work', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
}
