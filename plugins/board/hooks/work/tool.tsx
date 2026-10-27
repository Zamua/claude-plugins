import type { EngineInterface, On } from 'claude-code'

import { messageOf } from '../kit'
import { buildTree, isSessionId, ORIGINS, qualify, treeText, URGENCY } from './model'
import type { Item, ItemLink, Link, Node, Origin, Shape, Status, Tree } from './model'
import { liveNow, refreshLive, selfSession, startSession } from './sessions'
import { isLocal, itemsAndLinks, localId, readLocalNow, writeLocal } from './sources/file'
import type { LocalFile, LocalItem } from './sources/file'
import { currentWork, START_ENV, WORK_TOOL, workTree } from './view'
import type { WorkBoard } from './view'

const DESCRIPTION = `Read and change the work view of the board pane: one tree of everything the person works on, from their goals down to tasks, with responsibilities such as on-call or tooling beside them. Items nest to any depth; each has a kind (the person's own name for its level, such as Project or Task) and a status: needs (needs the person), flight (in flight), waiting, next, watching, done.
- Call with no fields to read the tree with every Item's id.
- add: new Items, each with a title and a kind, under a parent by id. A responsibility (shape: responsibility) never ends.
- update: change an Item's fields, including parent to move it. Mark finished work status done rather than removing it.
- remove: delete Items that have no children.
- link / unlink: set or clear a hand-set parent for any Item, Session or pull request, which wins over the parent its source gives. A session parent makes it that session's Coordinator; a Session keeps one Item parent and one Coordinator.
- attach: put this session under an Item.
- start: start a new session for an Item with a brief, as this session's child. It is refused when the Item already has a running session, naming it, so message that one instead, or pass again: true for another.
- root: true makes this session the root session, the one the person talks to; every breadcrumb and work view then starts with a mark that brings it to the front. root: false clears it.
- aliases: identifiers a session's workspace name or a pull request's title or branch may carry, such as an issue key, so they attach to the Item without a link.
A read lists each session under its Item with its state, the name to message it by, and the goal and summary from its session board.
Only Items whose ids start with file: (or have no prefix) can be added, updated or removed; Items from other sources can only be linked. File changes apply together, or none do; a started session stays started. Keep titles to one short line.`

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
  aliases: { type: 'array', items: { type: 'string' }, description: 'Identifiers such as an issue key.' },
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
    attach: { type: 'string', description: 'The Item id to put this session under.' },
    root: { type: 'boolean', description: 'Make this session the root session, or clear the root with false.' },
    start: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'The Item id the new session serves.' },
          brief: { type: 'string', description: 'The first prompt the new session gets: what to do, the decisions made, where to stop.' },
          label: { type: 'string', description: 'Its workspace name; by default, from the Item.' },
          cwd: { type: 'string' },
          again: { type: 'boolean', description: 'Start one even though the Item has a running session.' },
        },
        required: ['item', 'brief'],
      },
    },
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
  aliases?: string[]
}
type Start = { item: string; brief: string; label?: string; cwd?: string; again?: boolean }
type Input = {
  add?: (Fields & { title: string; kind: string })[]
  update?: (Fields & { id: string })[]
  remove?: string[]
  link?: { child: string; parent: string }[]
  unlink?: string[]
  attach?: string
  start?: Start[]
  root?: boolean
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

/** A Session keeps one Item parent and one Coordinator, so a new link replaces only the old one of its kind. */
const sameKind = (link: Link, child: string, parent: string) =>
  qualify(link.child) === child && isSessionId(link.parent) === isSessionId(parent)

const WORDS = 5

/** A workspace name from an Item: its first alias and its title, in lowercase kebab case of a few words. */
export function labelFor(item: Item, taken: ReadonlySet<string>): string {
  const alias = item.aliases[0] ?? ''
  const title = alias && item.title.toLowerCase().startsWith(alias.toLowerCase()) ? item.title.slice(alias.length) : item.title
  const words = `${alias} ${title}`.trim().split(/\s+/).slice(0, WORDS).join(' ')
  const base = slug(words)
  let label = base
  for (let n = 2; taken.has(label); n++) label = `${base}-${n}`

  return label
}

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
    if (!known.has(parent) && !isSessionId(parent)) return { error: `No Item ${one.parent}.` }
    if (isSessionId(parent) && !isSessionId(child)) return { error: `Only a session can sit under the session ${one.parent}.` }
    links = [...links.filter(link => !sameKind(link, child, parent)), { child, parent, at: now }]
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
    const isRead =
      !input.add?.length &&
      !input.update?.length &&
      !input.remove?.length &&
      !input.link?.length &&
      !input.unlink?.length &&
      input.attach === undefined &&
      input.root === undefined &&
      !input.start?.length
    let current: LocalFile
    try {
      current = await readLocalNow($, w.path)
    } catch (err) {
      return { deny: messageOf(err) }
    }
    if (isRead) {
      await refreshLive($, w.spec, true)
      const { tree } = workTree(current)
      const root = typeof current.root === 'string' ? current.root : undefined
      return { result: tree ? treeText(tree, root) : 'The work board is empty.' }
    }

    return change($, w, current, input)
  })
}

/** Where a started session runs: the start's own cwd, else the first Host's configured one, else home. */
async function cwdOf($: EngineInterface, w: WorkBoard, asked: string | undefined) {
  const home = (await $.env.get('HOME')) ?? ''
  const host = Object.values(w.spec.hosts ?? {})[0] as { cwd?: unknown } | undefined
  const cwd = asked ?? (typeof host?.cwd === 'string' ? host.cwd : '~')

  return cwd === '~' ? home : cwd.startsWith('~/') ? home + cwd.slice(1) : cwd
}

/**
 * Applies the file changes, then starts each asked-for session and links it under its Item with this session as its
 * Coordinator. A Host cannot undo a start, so a start that fails leaves the ones before it, and the result says so.
 */
async function change($: EngineInterface, w: WorkBoard, current: LocalFile, input: Input) {
  const now = new Date(await $.clock.now()).toISOString()
  const starts = input.start ?? []
  const needsSelf = input.attach !== undefined || input.root === true || starts.length > 0
  const self = needsSelf ? await selfSession($, w.spec) : undefined
  if (input.attach !== undefined && !self) return { deny: 'No host lists this session, so it cannot be attached.' }
  if (input.root === true && !self) return { deny: 'No host lists this session, so it cannot be the root.' }
  const attach = input.attach !== undefined && self ? [{ child: self.id, parent: input.attach }] : []
  const applied = applyChange(current, { ...input, link: [...(input.link ?? []), ...attach] }, now)
  if ('error' in applied) return { deny: applied.error }

  const tree = workTree(applied.file).tree as Tree
  for (const one of starts) {
    const node = tree.byId.get(qualify(one.item))
    if (!node) return { deny: `No Item ${one.item} to start a session for.` }
    if (!one.brief?.trim()) return { deny: `The start for ${one.item} needs a brief.` }
    const running = node.sessions[0]
    if (running && !one.again) {
      const message = running.messageName ? `, message ${running.messageName}` : ''
      return {
        deny: `${node.item.id} already has a running session, ${running.label}${message}. Message it instead, or pass again: true to start another.`,
      }
    }
  }

  let file = applied.file
  if (input.root === true && self) file = { ...file, root: self.id }
  if (input.root === false) {
    const { root: _cleared, ...rest } = file
    file = rest as LocalFile
  }
  const started: string[] = []
  const failed: string[] = []
  const taken = new Set(liveNow().sessions.map(one => one.label))
  for (const one of starts) {
    const { item } = tree.byId.get(qualify(one.item)) as Node
    const label = one.label?.trim() || labelFor(item, taken)
    taken.add(label)
    const cwd = await cwdOf($, w, one.cwd)
    const out = await startSession($, w.spec, {
      label,
      cwd,
      brief: one.brief,
      env: { [START_ENV]: item.id },
      ...(self && { near: self.address }),
    })
    if (!out.id) {
      failed.push(out.error ?? `${label} did not start.`)
      continue
    }
    const id = out.id
    const coordinated = self ? [{ child: id, parent: self.id, at: now }] : []
    file = { ...file, links: [...file.links, { child: id, parent: item.id, at: now }, ...coordinated] }
    const name = liveNow().sessions.find(s => s.id === id)?.messageName
    started.push(`${id} (${label}${name ? `, message ${name}` : ''}) for ${item.id}`)
  }
  await writeLocal($, w.state, w.path, file)
  $.ui.invalidate('ui.render')

  const parts = ['Work updated.']
  if (applied.added.length > 0) parts.push(`Added ${applied.added.join(', ')}.`)
  if (started.length > 0) parts.push(`Started ${started.join('; ')}.`)
  if (failed.length > 0) parts.push(`Not started: ${failed.join(' ')}`)

  return { result: parts.join(' ') }
}

export async function workToolStart($: EngineInterface) {
  await $.tool.register({ name: 'work', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
}
