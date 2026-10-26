import type { Color, EngineInterface, RenderNode } from 'claude-code'

import { ago, dueOf, focusWorkspace, openUrl, refreshJson, section, sourceLabel, span } from '../kit'
import type { Els, JsonFile, View } from '../kit'

/** A board another process writes as JSON, named in the board config. */
export type FileBoardSpec = {
  id: string
  title?: string
  path: string
  /** `sections` draws one box per status; `groups` one box per project, nesting workstreams. */
  layout?: 'sections' | 'groups'
  /** A board older than this says its writer may be stuck. */
  stale_minutes?: number
  stale_text?: string
  /** Section titles by status id, over the defaults. */
  titles?: Record<string, string>
}

/** Two links drawn on one line when the second is the first's sibling page for the same id. */
export type LinkPair = { first: string; second: string; label: string }

export type Shared = { labels: Record<string, string>; pairs: LinkPair[] }

type Link = { url?: string; label?: string }
type Item = {
  id: string
  ref?: number
  section?: string
  group?: string
  title: string
  workspace?: string
  source?: string
  source_label?: string
  links?: Link[]
  due?: string
  due_label?: string
}
type Group = {
  id: string
  parent?: string
  title?: string
  source?: string
  source_label?: string
  links?: Link[]
}
type Data = { updated_at?: string; items?: Item[]; groups?: Group[] }

type Status = {
  id: string
  title: string
  tag: string
  color: Color
  isQuiet?: boolean
  empty?: string
}

// An item's section is its status, in draw order; colors are theme keys, so they follow the person's theme
const STATUSES: readonly Status[] = [
  { id: 'needs', title: 'Needs you', tag: 'you', color: 'warning', empty: 'Nothing needs you' },
  { id: 'flight', title: 'Running', tag: 'now', color: 'success' },
  { id: 'next', title: 'Up next', tag: 'next', color: 'suggestion' },
  { id: 'waiting', title: 'Waiting', tag: 'wait', color: 'permission' },
  { id: 'watching', title: 'Watching', tag: 'watch', color: 'suggestion' },
  { id: 'done', title: 'Done', tag: 'done', color: 'inactive', isQuiet: true },
]
const TAG_WIDTH = Math.max(...STATUSES.map(s => s.tag.length))
const POLL_MS = 15_000
const OTHER: Group = { id: 'other', title: 'Other' }

const DONE = STATUSES[STATUSES.length - 1] as Status
const statusOf = (item: Item) => STATUSES.find(s => s.id === item.section) ?? DONE
const statusRank = (item: Item) => STATUSES.indexOf(statusOf(item))
const refOf = (item: Item) => (Number.isInteger(item.ref) ? `#${item.ref} ` : '')
const itemsOf = (data: Data) => (Array.isArray(data.items) ? data.items : [])
const linksOf = (owner: { links?: Link[] }) => (Array.isArray(owner.links) ? owner.links : [])

type Ctx = {
  els: Els
  now: number
  shared: Shared
  open: (url: string) => () => Promise<void>
  jump: (item: Item) => (() => Promise<void>) | undefined
}

/** A file board's lasting state, kept across the views built from it. */
export type FileBoard = {
  spec: FileBoardSpec
  path: string
  shared: Shared
  statuses: readonly Status[]
  file: JsonFile<Data>
  /** The last jump or link that failed, shown in the footer until the next one succeeds. */
  notice?: string | undefined
}

export function fileBoard(spec: FileBoardSpec, shared: Shared, home: string): FileBoard {
  return {
    spec,
    path: spec.path.startsWith('~/') ? home + spec.path.slice(1) : spec.path,
    shared,
    statuses: STATUSES.map(s => ({ ...s, title: spec.titles?.[s.id] ?? s.title })),
    file: {},
  }
}

export async function fileRefresh($: EngineInterface, board: FileBoard) {
  if (await refreshJson($, board.file, board.path)) $.ui.invalidate('ui.render')
}

export async function fileStart($: EngineInterface, board: FileBoard) {
  await fileRefresh($, board)
  $.clock.every(POLL_MS, () => fileRefresh($, board))
}

export function fileView($: EngineInterface, board: FileBoard): View {
  const { spec, path, shared, statuses, file } = board

  const footer = (els: Els, data: Data, now: number) => {
    const { Text } = els
    const at = Date.parse(data.updated_at ?? '')
    const age = now - at
    const stale = spec.stale_minutes ? spec.stale_minutes * 60_000 : undefined
    if (stale !== undefined && !Number.isNaN(at) && age > stale) {
      return (
        <Text key="footer" color="red" wrap="wrap">
          {`Not updated for ${span(age)}. ${spec.stale_text ?? 'Its writer may be stuck.'}`}
        </Text>
      )
    }
    if (board.notice) {
      return (
        <Text key="footer" color="yellow" wrap="wrap">
          {board.notice}
        </Text>
      )
    }
    const updated = !Number.isNaN(at) && age >= 0 ? `Updated ${ago(age)}. ` : ''

    return (
      <Text key="footer" dimColor wrap="wrap">
        {`${updated}A title opens its herdr workspace; the lines under it open links.`}
      </Text>
    )
  }

  return {
    id: spec.id,
    title: spec.title ?? spec.id,
    scope: 'shared',
    onShow: () => fileRefresh($, board),
    isAvailable: async () => !file.isMissing,
    needs: async () => (file.value ? itemsOf(file.value).filter(item => item.section === 'needs').length : 0),
    render: async els => {
      const { Box, Text } = els
      const data = file.value
      if (!data) {
        const why = file.error
          ? `Could not read the board: ${file.error}`
          : file.isMissing
            ? `No board yet at ${path}`
            : 'Waiting for the first board.'

        return (
          <Text dimColor wrap="wrap">
            {why}
          </Text>
        )
      }
      const ctx: Ctx = {
        els,
        now: await $.clock.now(),
        shared,
        open: url => async () => {
          board.notice = await openUrl($, url)
          $.ui.invalidate('ui.render')
        },
        jump: item => {
          const { workspace } = item
          if (!workspace) return undefined

          return async () => {
            board.notice = await focusWorkspace($, workspace)
            $.ui.invalidate('ui.render')
          }
        },
      }
      const body = spec.layout === 'groups' ? groupsLayout(ctx, data) : sectionsLayout(ctx, data, statuses)

      return (
        <Box flexDirection="column">
          {body}
          {footer(els, data, ctx.now)}
        </Box>
      )
    },
  }
}

/** One box per status, needs first; Needs you always draws, so an empty one still says so. */
function sectionsLayout(ctx: Ctx, data: Data, statuses: readonly Status[]): RenderNode[] {
  const out: RenderNode[] = []
  for (const status of statuses) {
    const items = itemsOf(data).filter(item => item.section === status.id)
    if (items.length === 0 && !status.empty) continue
    out.push(section(ctx.els, status, items.length, items.map(item => itemRow(ctx, item, { quiet: status.isQuiet }))))
  }

  return out
}

type Tree = { top: Group[]; itemsOf: (id: string) => Item[]; childrenOf: (id: string) => Group[] }

/**
 * Groups nest by `parent`. An item names its group; one naming no known group, and a group whose parent is unknown,
 * fall to the top level, so a typo never hides an item.
 */
function groupTree(data: Data): Tree {
  const groups = (Array.isArray(data.groups) ? data.groups : []).filter(g => g && g.id)
  const known = new Set(groups.map(g => g.id))
  const items = itemsOf(data)
  const parentOf = (g: Group) => (g.parent && known.has(g.parent) && g.parent !== g.id ? g.parent : undefined)
  const top = groups.filter(g => !parentOf(g))
  if (items.some(item => !known.has(item.group ?? ''))) top.push(OTHER)

  return {
    top,
    itemsOf: id =>
      items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => (known.has(item.group ?? '') ? item.group === id : id === OTHER.id))
        .sort((a, b) => statusRank(a.item) - statusRank(b.item) || a.index - b.index)
        .map(({ item }) => item),
    childrenOf: id => groups.filter(g => parentOf(g) === id),
  }
}

function openCount(tree: Tree, group: Group): number {
  const own = tree.itemsOf(group.id).filter(item => item.section !== 'done').length

  return tree.childrenOf(group.id).reduce((sum, child) => sum + openCount(tree, child), own)
}

function groupsLayout(ctx: Ctx, data: Data): RenderNode[] {
  const { Box } = ctx.els
  const tree = groupTree(data)

  return [
    summary(ctx, data),
    ...tree.top.map(group => (
      <Box
        key={`group-${group.id}`}
        flexDirection="column"
        borderStyle="round"
        borderColor={group === OTHER ? 'inactive' : 'claude'}
        paddingX={1}
      >
        {groupBody(ctx, tree, group, 0)}
      </Box>
    )),
  ]
}

/** Groups split up next across projects, so the take order is listed once here. */
function summary(ctx: Ctx, data: Data) {
  const { Box, Text } = ctx.els
  const items = itemsOf(data)
  const counted = STATUSES.filter(s => !s.isQuiet).filter(
    s => s.id === 'needs' || items.some(item => item.section === s.id),
  )
  const next = items
    .filter(item => item.section === 'next')
    .map(item => refOf(item).trim())
    .filter(Boolean)

  return (
    <Box key="summary" flexDirection="column" paddingX={1}>
      <Box key="counts" flexDirection="row" columnGap={2}>
        {counted.map(s => (
          <Text color={s.color} bold={s.id === 'needs' || undefined}>
            {`${s.tag} ${items.filter(item => item.section === s.id).length}`}
          </Text>
        ))}
      </Box>
      {next.length > 0 && (
        <Text dimColor wrap="wrap">
          {`Up next: ${next.join(', ')}`}
        </Text>
      )}
    </Box>
  )
}

/**
 * A group draws its open items, then its workstreams, then what it finished. Finished items show their title alone,
 * so history stays out of the way of the work, and everything under a heading is indented, so a workstream heading
 * never reads as one of the items above it.
 */
function groupBody(ctx: Ctx, tree: Tree, group: Group, depth: number): RenderNode[] {
  const { Box, Text } = ctx.els
  const open = openCount(tree, group)
  const items = tree.itemsOf(group.id)
  const children = tree.childrenOf(group.id)
  const done = items.filter(item => item.section === 'done')
  const body: RenderNode[] = []
  const links = groupLinks(ctx, group)
  if (links) body.push(links)
  body.push(...items.filter(item => item.section !== 'done').map(item => itemRow(ctx, item, { tagged: true })))
  for (const child of children) {
    body.push(
      <Box key={`group-${child.id}`} flexDirection="column" marginTop={1}>
        {groupBody(ctx, tree, child, depth + 1)}
      </Box>,
    )
  }
  if (done.length > 0) {
    body.push(
      <Box key={`done-${group.id}`} flexDirection="column" marginTop={children.length > 0 ? 1 : 0}>
        {done.map(item => itemRow(ctx, item, { tagged: true, compact: true }))}
      </Box>,
    )
  }

  return [
    <Box key={`heading-${group.id}`} flexDirection="row" columnGap={1}>
      <Text bold color={depth > 0 ? 'claude' : undefined}>
        {group.title || group.id}
      </Text>
      {open > 0 && <Text dimColor>{String(open)}</Text>}
    </Box>,
    <Box key={`body-${group.id}`} flexDirection="column" paddingLeft={2}>
      {body}
    </Box>,
  ]
}

/** One wrapping row of short labels, so a project's standing links cost a line rather than one each. */
function groupLinks(ctx: Ctx, group: Group) {
  const { Box, Button, Text } = ctx.els
  const links: { label: string; url: string }[] = []
  if (group.source) links.push({ label: group.source_label || label(ctx, group.source), url: group.source })
  for (const one of linksOf(group)) {
    if (one && one.url) links.push({ label: one.label || label(ctx, one.url), url: one.url })
  }
  if (links.length === 0) return undefined

  return (
    <Box key={`glinks-${group.id}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
      {links.flatMap((one, i) => [
        ...(i > 0 ? [<Text dimColor>·</Text>] : []),
        <Button key={`glink-${group.id}-${i}`} label={one.label} plain dimColor onPress={ctx.open(one.url)} />,
      ])}
    </Box>
  )
}

const label = (ctx: Ctx, url: string) => sourceLabel(url, ctx.shared.labels)

type Bullet = { key: string; label: string; url: string }

/**
 * The item's links after its source, each once since several sessions edit a board, keyed by where they sit in the
 * item. A link followed by its pair's sibling page for the same id shares one line with it.
 */
function bulletsOf(ctx: Ctx, item: Item): Bullet[][] {
  const lines: Bullet[][] = []
  const seen = new Set<string>()
  if (item.source) {
    seen.add(item.source)
    lines.push([{ key: `src-${item.id}`, label: item.source_label || label(ctx, item.source), url: item.source }])
  }
  const links = linksOf(item)
    .map((one, index) => ({ one, index }))
    .filter(({ one }) => {
      if (!one || !one.url || seen.has(one.url)) return false
      seen.add(one.url)

      return true
    })
  for (let at = 0; at < links.length; at++) {
    const { one, index } = links[at] as { one: Link & { url: string }; index: number }
    const bullet = { key: `link-${item.id}-${index}`, label: one.label || label(ctx, one.url), url: one.url }
    const next = links[at + 1]
    const pair = ctx.shared.pairs.find(p => {
      const id = one.url.startsWith(p.first) ? one.url.slice(p.first.length) : ''

      return /^[\w-]+$/.test(id) && next?.one.url === p.second + id
    })
    if (pair && next) {
      lines.push([bullet, { key: `link-${item.id}-${next.index}`, label: pair.label, url: next.one.url as string }])
      at++
    } else {
      lines.push([bullet])
    }
  }

  return lines
}

function itemRow(ctx: Ctx, item: Item, opts: { tagged?: boolean; compact?: boolean; quiet?: boolean }) {
  const { Box, Text, Button } = ctx.els
  const status = statusOf(item)
  const quiet = opts.quiet || (opts.tagged && status.isQuiet) || undefined
  const title = refOf(item) + item.title
  const jump = ctx.jump(item)
  const due = dueOf(item.due, item.due_label, ctx.now)
  const head = (
    <Box key={`head-${item.id}`} flexDirection="row" columnGap={1}>
      {opts.tagged && (
        <Text bold={!quiet} color={status.color} dimColor={quiet}>
          {status.tag.padEnd(TAG_WIDTH)}
        </Text>
      )}
      {jump ? (
        <Button key={`title-${item.id}`} label={title} plain dimColor={quiet} onPress={jump} />
      ) : (
        <Text dimColor={quiet}>{title}</Text>
      )}
      {due && (due.color ? <Text color={due.color}>{due.text}</Text> : <Text dimColor>{due.text}</Text>)}
    </Box>
  )
  if (opts.compact) {
    return (
      <Box key={`row-${item.id}`} flexDirection="column">
        {head}
      </Box>
    )
  }
  // Indented past the tag, so subitems sit under the title
  const dot = opts.tagged ? `${' '.repeat(TAG_WIDTH)}·` : '   ·'

  return (
    <Box key={`row-${item.id}`} flexDirection="column">
      {head}
      {bulletsOf(ctx, item).map(line => (
        <Box key={`line-${line[0]?.key}`} flexDirection="row" columnGap={1}>
          <Text dimColor>{dot}</Text>
          {line.map(b => (
            <Button key={b.key} label={b.label} plain dimColor onPress={ctx.open(b.url)} />
          ))}
        </Box>
      ))}
    </Box>
  )
}
