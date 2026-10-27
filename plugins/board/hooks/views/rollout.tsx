import type { Color, EngineInterface, RenderNode } from 'claude-code'

import { ago, openUrl, refreshJson, sourceLabel, spans, stamp } from '../kit'
import type { Els, JsonFile, Part, View } from '../kit'
import { paneWidth } from '../pane'
import { openWorkAt } from '../work/view'

/** A `rollout` board as `boards.json` names it. */
export type RolloutSpec = { id: string; title?: string; path: string }

type RolloutItem = {
  id: string
  title: string
  status: string
  owner?: string
  note?: string
  env?: Record<string, string>
  after?: string[]
  detail?: string
  links?: { label?: string; url: string }[]
  work?: string
}
type Section = { id: string; title: string; items?: RolloutItem[] }
type Rollout = { title?: string; updated_at?: string; envs?: string[]; sections?: Section[] }

export type RolloutBoard = {
  spec: RolloutSpec
  path: string
  file: JsonFile<Rollout>
  labels: Record<string, string>
  /** The last press that failed, until the next one succeeds. */
  notice?: string | undefined
}

type Look = { tag: string; color: Color; bold?: boolean; dimColor?: boolean }

const STATUSES: Record<string, Look> = {
  gap: { tag: 'gap', color: 'warning', bold: true },
  blocked: { tag: 'block', color: 'error' },
  doing: { tag: 'doing', color: 'success' },
  ready: { tag: 'ready', color: 'suggestion' },
  todo: { tag: 'todo', color: 'inactive' },
  watching: { tag: 'watch', color: 'permission' },
  done: { tag: 'done', color: 'inactive', dimColor: true },
}
const ORDER = ['gap', 'blocked', 'doing', 'ready', 'todo', 'watching', 'done']
const TAG_WIDTH = Math.max(...Object.values(STATUSES).map(look => look.tag.length))
// A folded section still shows these, since they are what the person has to act on
const ALWAYS_SHOWN = new Set(['gap', 'blocked'])
const POLL_MS = 15_000
// The fewest cells a cut title or note is still worth drawing in, and the most an owner or an env value takes
const MIN_TITLE = 16
const MIN_TAIL = 12
const MAX_OWNER = 14
const MAX_ENV = 7

// What the person pressed open, for the session `pressedFor` names
const opened = new Set<string>()
let pressedFor = ''

const lookOf = (status: string): Look => STATUSES[status] ?? { tag: status.slice(0, TAG_WIDTH), color: 'inactive' }
const cells = (text: string) => [...text].length
const cut = (text: string, room: number) =>
  cells(text) <= room ? text : `${[...text].slice(0, Math.max(0, room - 1)).join('')}…`

export function rolloutBoard(spec: RolloutSpec, home: string, labels: Record<string, string>): RolloutBoard {
  return { spec, path: spec.path.startsWith('~/') ? home + spec.path.slice(1) : spec.path, file: {}, labels }
}

export async function rolloutRefresh($: EngineInterface, board: RolloutBoard) {
  if (await refreshJson($, board.file, board.path)) $.ui.invalidate('ui.render')
}

export async function rolloutStart($: EngineInterface, board: RolloutBoard) {
  await rolloutRefresh($, board)
  $.clock.every(POLL_MS, () => rolloutRefresh($, board))
}

function toggle($: EngineInterface, key: string) {
  return async () => {
    if (opened.has(key)) opened.delete(key)
    else opened.add(key)
    $.ui.invalidate('ui.render')
  }
}

/**
 * The tag, the title, the owner, then the note, in at most `room` cells. The title comes first; the owner shows where
 * it fits, and the note where enough is left to read. What an item waits on stands in for its note, keeps room ahead
 * of the owner, since it says why the item cannot move.
 */
function lineOf(room: number, look: Look, item: RolloutItem, waitsOn: string | undefined): Part[] {
  const quiet = item.status === 'done'
  const parts: Part[] = [{ text: look.tag.padEnd(TAG_WIDTH), color: look.color, bold: look.bold, dimColor: look.dimColor }]
  let left = room - TAG_WIDTH - 1
  const tail = waitsOn ? `after ${waitsOn}` : item.note
  const title = cut(item.title, Math.max(MIN_TITLE, left - (waitsOn ? MIN_TAIL + 1 : 0)))
  parts.push({ text: title, dimColor: quiet })
  left -= cells(title) + 1
  const owner = item.owner ? cut(item.owner, MAX_OWNER) : ''
  const tailPart = (room: number): Part =>
    waitsOn ? { text: cut(tail ?? '', room), color: 'permission' } : { text: cut(tail ?? '', room), dimColor: true }
  if (waitsOn && left >= MIN_TAIL) {
    const shown = tailPart(left - (owner ? Math.min(cells(owner) + 1, left - MIN_TAIL) : 0))
    parts.push(shown)
    left -= cells(shown.text) + 1
    if (owner && cells(owner) <= left) parts.push({ text: owner, dimColor: true })

    return parts
  }
  if (owner && cells(owner) + 1 <= left) {
    parts.push({ text: owner, dimColor: true })
    left -= cells(owner) + 1
  }
  if (tail && left >= MIN_TAIL) parts.push(tailPart(left))

  return parts
}

const ENV_COLORS: Record<string, Color> = {
  on: 'success',
  set: 'success',
  done: 'success',
  allowed: 'success',
  gap: 'warning',
  missing: 'warning',
  unknown: 'warning',
  blocked: 'error',
  suspended: 'error',
}
const ENV_QUIET = new Set(['off', 'n/a', 'todo', 'pending'])

/** An env value's look: green once in place, yellow where unknown or missing, red where stopped, dim where not yet. */
const envLook = (value: string): { color?: Color; dimColor?: boolean } =>
  ENV_COLORS[value] ? { color: ENV_COLORS[value] } : value.endsWith('%') ? { color: 'warning' } : ENV_QUIET.has(value) ? { dimColor: true } : {}

export function rolloutView($: EngineInterface, board: RolloutBoard): View {
  const { spec } = board

  return {
    id: spec.id,
    title: spec.title ?? spec.id,
    scope: 'shared',
    onShow: () => rolloutRefresh($, board),
    isAvailable: async () => !board.file.isMissing,
    // Gaps are the decisions waiting on the person
    needs: async () =>
      (board.file.value?.sections ?? []).reduce((n, s) => n + (s.items ?? []).filter(i => i.status === 'gap').length, 0),
    render: async els => {
      const { Box, Text } = els
      const sessionId = await $.session.id()
      if (pressedFor !== sessionId) {
        opened.clear()
        pressedFor = sessionId
      }
      const data = board.file.value
      if (!data) {
        const why = board.file.error
          ? `Could not read ${board.path}: ${board.file.error}`
          : board.file.isMissing
            ? `No rollout file yet at ${board.path}.`
            : 'Reading the rollout file.'

        return (
          <Text dimColor wrap="wrap">
            {why}
          </Text>
        )
      }
      const now = await $.clock.now()
      const at = Date.parse(data.updated_at ?? '')
      const envs = data.envs ?? []
      const sections = data.sections ?? []
      const all = sections.flatMap(s => s.items ?? [])
      const byId = new Map(all.map(item => [item.id, item]))
      const values = all.flatMap(item => envs.map(env => item.env?.[env] ?? ''))
      const width = Math.min(MAX_ENV, Math.max(0, ...envs.map(cells), ...values.map(cells)))
      const ctx = { els, envs, width, byId, columns: paneWidth() - 1 }

      return (
        <Box key="rollout-view" flexDirection="column">
          {!Number.isNaN(at) && stamp(els, `Updated ${ago(now - at)}`)}
          {sections.map((section, at) => sectionBlock(ctx, section, at))}
          {board.notice && (
            <Text color="yellow" wrap="wrap">
              {board.notice}
            </Text>
          )}
        </Box>
      )
    },
  }

  type Ctx = { els: Els; envs: string[]; width: number; byId: Map<string, RolloutItem>; columns: number }

  /** The environments' cells at the right edge, each as wide as the widest name or value. */
  function envCells(ctx: Ctx, key: string, texts: { text: string; color?: Color; dimColor?: boolean }[]) {
    const { Box, Text } = ctx.els

    return (
      <Box key={`renv-${key}`} flexDirection="row" columnGap={1} flexShrink={0} marginLeft={1}>
        {texts.map((one, i) => (
          <Box key={`renv-${key}-${i}`} width={ctx.width}>
            <Text color={one.color} dimColor={one.dimColor || undefined}>
              {cut(one.text, ctx.width)}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  /** A section's header with its counts, then its gaps and blockers, or every item once pressed open. */
  function sectionBlock(ctx: Ctx, section: Section, at: number): RenderNode {
    const { Box, Button } = ctx.els
    const items = section.items ?? []
    const key = `s:${section.id}`
    const isOpen = opened.has(key)
    const shown = isOpen ? items : items.filter(item => ALWAYS_SHOWN.has(item.status))
    const hasEnv = ctx.envs.length > 0 && items.some(item => item.env)
    const envWidth = hasEnv ? ctx.envs.length * (ctx.width + 1) : 0
    const counts = ORDER.flatMap(status => {
      const n = items.filter(item => item.status === status).length
      if (n === 0) return []
      const look = lookOf(status)

      return [{ text: `${n} ${look.tag}`, ...(ALWAYS_SHOWN.has(status) ? { color: look.color } : { dimColor: true }) }]
    })
    const glyph = isOpen ? '▾' : '▸'
    const countsWidth = counts.reduce((n, part) => n + cells(part.text) + 3, 0)
    const title = cut(section.title, Math.max(8, ctx.columns - 2 - countsWidth))
    const header: Part[] = [{ text: glyph, dimColor: true }, { text: title, bold: true }]
    const withCounts = counts.flatMap((part, i) => [...(i > 0 ? [{ text: '·', dimColor: true }] : []), part])

    return (
      <Box key={`rsection-${section.id}`} flexDirection="column" marginTop={at > 0 ? 1 : 0}>
        <Button key={`rsec-${section.id}`} plain onPress={toggle($, key)}>
          {spans(ctx.els, [...header, ...withCounts])}
        </Button>
        {hasEnv && shown.some(item => item.env) && (
          <Box key={`renvs-${section.id}`} flexDirection="row" justifyContent="flex-end">
            {envCells(ctx, `head-${section.id}`, ctx.envs.map(env => ({ text: cut(env, ctx.width), dimColor: true })))}
          </Box>
        )}
        {shown.flatMap(item => rowLines(ctx, item, hasEnv, envWidth))}
      </Box>
    )
  }

  function rowLines(ctx: Ctx, item: RolloutItem, hasEnv: boolean, envWidth: number): RenderNode[] {
    const { Box, Button } = ctx.els
    const key = `i:${item.id}`
    const isOpen = opened.has(key)
    const waiting = (item.after ?? []).map(id => ctx.byId.get(id)).filter(one => one && one.status !== 'done')
    const look = lookOf(item.status)
    const line = lineOf(ctx.columns - 2 - envWidth, look, item, waiting[0]?.title)
    const out: RenderNode[] = [
      <Box key={`rrow-${item.id}`} flexDirection="row" paddingLeft={2}>
        <Button key={`ritem-${item.id}`} plain onPress={toggle($, key)}>
          {spans(ctx.els, line)}
        </Button>
        {hasEnv && <Box key={`rgap-${item.id}`} flexGrow={1} />}
        {hasEnv &&
          envCells(
            ctx,
            item.id,
            ctx.envs.map(env => {
              const value = item.env?.[env] ?? ''
              return { text: value, ...envLook(value) }
            }),
          )}
      </Box>,
    ]
    if (isOpen) out.push(details(ctx, item, waiting as RolloutItem[]))

    return out
  }

  /** An opened item: who owns it and its note, what it waits on, its detail dim, then its links and work Item. */
  function details(ctx: Ctx, item: RolloutItem, waiting: RolloutItem[]): RenderNode {
    const { Box, Button, Markdown, Text } = ctx.els
    const room = ctx.columns - 4 - 2
    const press = (id: string, url: string) => (
      <Button
        key={`rlink-${item.id}-${id}`}
        plain
        onPress={async () => {
          board.notice = await openUrl($, url)
          $.ui.invalidate('ui.render')
        }}
      >
        {spans(ctx.els, [{ text: '↗', color: 'suggestion' }, { text: cut(id, room), color: 'suggestion' }])}
      </Button>
    )
    const links = (item.links ?? []).map(one => press(one.label || sourceLabel(one.url, board.labels), one.url))
    const { work } = item
    if (work) {
      links.push(
        <Button key={`rwork-${item.id}`} plain onPress={() => openWorkAt($, work)}>
          {spans(ctx.els, [{ text: '↗', color: 'suggestion' }, { text: cut(`work: ${work}`, room), color: 'suggestion' }])}
        </Button>,
      )
    }

    return (
      <Box
        key={`rmore-${item.id}`}
        flexDirection="column"
        rowGap={1}
        marginLeft={4}
        paddingLeft={1}
        borderStyle="quote"
        borderColor="inactive"
      >
        {(item.owner || item.note) && (
          <Text dimColor wrap="wrap">
            {[item.owner, item.note].filter(Boolean).join(' · ')}
          </Text>
        )}
        {waiting.length > 0 && (
          <Text color="permission">{`After ${waiting.map(one => `${one.title} (${one.status})`).join(', ')}`}</Text>
        )}
        {item.detail && <Markdown key={`rdetail-${item.id}`} dimColor text={item.detail} />}
        {links.length > 0 && (
          <Box key={`rlinks-${item.id}`} flexDirection="column">
            {links}
          </Box>
        )}
      </Box>
    )
  }
}
