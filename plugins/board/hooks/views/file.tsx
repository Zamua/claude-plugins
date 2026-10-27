import type { Color, EngineInterface, RenderNode } from 'claude-code'

import { ago, dueOf, openUrl, refreshJson, section, sourceLabel, span } from '../kit'
import type { Els, JsonFile, View } from '../kit'
import { focusWorkspace } from '../work/hosts/herdr'

/** A board another process writes as JSON, named in the board config. */
export type FileBoardSpec = {
  id: string
  title?: string
  path: string
  layout?: 'sections'
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
  title: string
  workspace?: string
  source?: string
  source_label?: string
  links?: Link[]
  due?: string
  due_label?: string
}
type Data = { updated_at?: string; items?: Item[] }

type Status = {
  id: string
  title: string
  color: Color
  isQuiet?: boolean
  empty?: string
}

// An item's section is its status, in draw order; colors are theme keys, so they follow the person's theme
const STATUSES: readonly Status[] = [
  { id: 'needs', title: 'Needs you', color: 'warning', empty: 'Nothing needs you' },
  { id: 'flight', title: 'Running', color: 'success' },
  { id: 'next', title: 'Up next', color: 'suggestion' },
  { id: 'waiting', title: 'Waiting', color: 'permission' },
  { id: 'watching', title: 'Watching', color: 'suggestion' },
  { id: 'done', title: 'Done', color: 'inactive', isQuiet: true },
]
const POLL_MS = 15_000

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
      return (
        <Box flexDirection="column">
          {sectionsLayout(ctx, data, statuses)}
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

function itemRow(ctx: Ctx, item: Item, opts: { quiet?: boolean }) {
  const { Box, Text, Button } = ctx.els
  const quiet = opts.quiet || undefined
  const title = refOf(item) + item.title
  const jump = ctx.jump(item)
  const due = dueOf(item.due, item.due_label, ctx.now)
  const head = (
    <Box key={`head-${item.id}`} flexDirection="row" columnGap={1}>
      {jump ? (
        <Button key={`title-${item.id}`} label={title} plain dimColor={quiet} onPress={jump} />
      ) : (
        <Text dimColor={quiet}>{title}</Text>
      )}
      {due && (due.color ? <Text color={due.color}>{due.text}</Text> : <Text dimColor>{due.text}</Text>)}
    </Box>
  )

  return (
    <Box key={`row-${item.id}`} flexDirection="column">
      {head}
      {bulletsOf(ctx, item).map(line => (
        <Box key={`line-${line[0]?.key}`} flexDirection="row" columnGap={1}>
          <Text dimColor>{'   ·'}</Text>
          {line.map(b => (
            <Button key={b.key} label={b.label} plain dimColor onPress={ctx.open(b.url)} />
          ))}
        </Box>
      ))}
    </Box>
  )
}
