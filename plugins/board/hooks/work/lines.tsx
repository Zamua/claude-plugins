import type { Color, EngineInterface, RenderNode } from 'claude-code'

import { dayOf, fitLine, fixed, link, openUrl, sourceLabel, span, spans } from '../kit'
import type { Els, Part } from '../kit'
import { selectView } from '../pane'
import type { PlacedBoard, WorkBoard } from './board'
import { isLate, rank, SESSION_STATES } from './model'
import type { Artifact, Node, Session, SessionState, Status, Tree } from './model'
import { focusSession } from './sessions'

const TAGS: Record<Status, { tag: string; color: Color }> = {
  needs: { tag: 'you', color: 'warning' },
  flight: { tag: 'now', color: 'success' },
  waiting: { tag: 'wait', color: 'permission' },
  next: { tag: 'next', color: 'suggestion' },
  watching: { tag: 'watch', color: 'suggestion' },
  done: { tag: 'done', color: 'inactive' },
}
const TAG_WIDTH = Math.max(...Object.values(TAGS).map(t => t.tag.length))

const SESSION_COLORS: Record<SessionState, Color> = {
  waiting: 'warning',
  done: 'suggestion',
  working: 'success',
  idle: 'inactive',
}
const STATE_WIDTH = Math.max(...SESSION_STATES.map(s => s.length))
const DAY_MS = 24 * 3600e3
// A date further off than this stays in an Item's detail, off its line
const SOON_MS = 7 * DAY_MS
const LEAD_WIDTH = 14
// A line's right side is fixed columns, so every count, date and session sits at the same place on every line
const COUNT_WIDTH = 2
const DATE_WIDTH = 'overdue'.length
const WAY_WIDTH = 2 + LEAD_WIDTH
const COLUMNS_WIDTH = 1 + COUNT_WIDTH + 1 + DATE_WIDTH + 1 + WAY_WIDTH

/** One drawing of the work view. `shows` holds the Items a chosen Period draws; absent, every Item draws. */
export type Ctx = {
  w: WorkBoard
  els: Els
  now: number
  tree: Tree
  self?: Session
  columns: number
  shows?: Set<string>
  /** The Items, Session lines and folded groups pressed open, by key. */
  opened: Set<string>
  doneShown: Set<string>
  placed: PlacedBoard[]
  /** What each placed board waits on the person for, by board id. */
  boardNeeds: Map<string, number>
}

const counted = (n: number, noun: string) => (n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`)
const widthOf = (parts: Part[]) => parts.reduce((n, part, at) => n + [...part.text].length + (at > 0 ? 1 : 0), 0)
const cut = (text: string, width: number) => ([...text].length <= width ? text : `${[...text].slice(0, width - 1).join('')}…`)

export function toggle($: EngineInterface, set: Set<string>, key: string) {
  return async () => {
    if (set.has(key)) set.delete(key)
    else set.add(key)
    $.ui.invalidate('ui.render')
  }
}

/** When an Item is due: now for one overdue or running late, else its nearer of target and ETA, if that is in a week. */
function dueAt(node: Node, now: number): number | undefined {
  if (node.shown === 'done') return undefined
  const target = node.item.target ? Date.parse(node.item.target) : NaN
  if (target < now || isLate(node)) return now
  const eta = node.eta ? Date.parse(node.eta) : NaN
  const soonest = Math.min(...[target, eta].filter(at => at >= now))

  return soonest - now <= SOON_MS ? soonest : undefined
}

/** The one date a line shows, in red when overdue or late, as a countdown inside a day and a weekday inside a week. */
function dateOf(node: Node, now: number): Part | undefined {
  const at = dueAt(node, now)
  if (at === undefined) return undefined
  const target = node.item.target ? Date.parse(node.item.target) : NaN
  if (target < now) return { text: 'overdue', color: 'red' }
  if (at === now && isLate(node)) return { text: 'late', color: 'red' }
  if (at - now < DAY_MS) return { text: `in ${span(at - now)}`, color: at - now < 2 * 3600e3 ? 'red' : 'yellow' }

  return { text: dayOf(at).split(' ')[0] ?? '', dimColor: true }
}

/** The top of the tree in the order the person works it: what needs them, then what is due soonest, then by status. */
export function ranked(nodes: Node[], now: number): Node[] {
  const due = (n: Node) => dueAt(n, now) ?? Infinity

  return [...nodes].sort(
    (a, b) => Number(b.shown === 'needs') - Number(a.shown === 'needs') || due(a) - due(b) || rank(a.shown) - rank(b.shown),
  )
}

/** The session that leads an Item: one attached to it that coordinates others, else the one active last. */
function leadOf(tree: Tree, node: Node): Session | undefined {
  const leads = node.sessions.filter(one => (tree.coordinated.get(one.id) ?? []).length > 0)

  return [...(leads.length > 0 ? leads : node.sessions)].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]
}

async function focus($: EngineInterface, ctx: Ctx, session: Session) {
  ctx.w.notice = await focusSession($, session)
  $.ui.invalidate('ui.render')
}

/** One level's open lines, then its finished ones folded behind a count. */
export function level($: EngineInterface, ctx: Ctx, key: string, all: Node[]): RenderNode[] {
  const { Box, Button } = ctx.els
  const nodes = ctx.shows ? all.filter(n => ctx.shows?.has(n.item.id)) : all
  const open = nodes.filter(n => n.shown !== 'done')
  const done = nodes.filter(n => n.shown === 'done')
  const out = open.flatMap(n => lines($, ctx, n))
  if (done.length === 0) return out
  out.push(
    <Box key={`wdonebox-${key}`} paddingLeft={(nodes[0]?.depth ?? 0) * 2}>
      <Button key={`wdone-${key}`} label={`✓ ${done.length} done`} plain dimColor onPress={toggle($, ctx.doneShown, key)} />
    </Box>,
  )
  if (ctx.doneShown.has(key)) out.push(...done.flatMap(n => lines($, ctx, n)))

  return out
}

function lines($: EngineInterface, ctx: Ctx, node: Node): RenderNode[] {
  const { item } = node
  const isOpen = ctx.opened.has(item.id)
  const out: RenderNode[] = [row($, ctx, node, isOpen)]
  if (!isOpen) return out
  const more = details($, ctx, node)
  if (more) out.push(more)
  out.push(...ctx.placed.filter(one => one.under === item.id).map(one => boardLine($, ctx, one, node.depth + 1)))
  out.push(...node.sessions.flatMap(s => sessionLines($, ctx, s, node.depth + 1, item.id, new Set())))
  out.push(...node.artifacts.map(a => artifactLine($, ctx, a, node.depth + 1)))
  if (node.children.length > 0) out.push(...level($, ctx, item.id, node.children))

  return out
}

/**
 * One line per Item, pressed anywhere to open or fold it: its status, its title cut to the room left, then fixed
 * columns pinned to the right edge at every depth: how many things need the person, when it is due, and a way to its
 * session. A top-level Item's way is the session that leads it, by label; a deeper one's is a mark. Every cell is
 * written, as spaces where a column is empty, since a row that shrinks otherwise keeps the old row's letters there.
 */
function row($: EngineInterface, ctx: Ctx, node: Node, isOpen: boolean) {
  const { Box, Text, Button } = ctx.els
  const { item } = node
  const tag = TAGS[node.shown]
  const quiet = node.shown === 'done'
  const parts: Part[] = [
    { text: isOpen ? '▾' : '▸', dimColor: true },
    node.shown === 'needs' ? { text: tag.tag.padEnd(TAG_WIDTH), color: tag.color } : { text: tag.tag.padEnd(TAG_WIDTH), dimColor: true },
  ]
  const when = dateOf(node, ctx.now)
  const count = node.needsCount > 0 ? String(node.needsCount) : ''
  const lead = node.depth === 0 ? leadOf(ctx.tree, node) : undefined
  const hasMark = !lead && node.sessions.length > 0
  const leadText = lead ? `→ ${cut(lead.label, LEAD_WIDTH)}` : ''
  const room = ctx.columns - node.depth * 2 - COLUMNS_WIDTH
  const line = fitLine(parts, { text: item.title, dimColor: quiet }, room)
  const pad = Math.max(0, room - widthOf(line))
  const wayPad = WAY_WIDTH - (lead ? [...leadText].length : hasMark ? 1 : 0)

  return (
    <Box key={`wrow-${item.id}`} flexDirection="row" paddingLeft={node.depth * 2}>
      <Button key={`wtoggle-${item.id}`} plain onPress={toggle($, ctx.opened, item.id)}>
        {spans(ctx.els, line)}
      </Button>
      {pad > 0 && fixed(ctx.els, `wpad-${item.id}`, <Text>{' '.repeat(pad)}</Text>)}
      <Box key={`wfact-${item.id}`} flexDirection="row" flexShrink={0}>
        <Text color="warning" bold>
          {` ${count.padStart(COUNT_WIDTH)} `}
        </Text>
        <Text color={when?.color} dimColor={when?.dimColor || undefined}>
          {`${(when?.text ?? '').padEnd(DATE_WIDTH)} `}
        </Text>
      </Box>
      {lead &&
        fixed(
          ctx.els,
          `wleadbox-${item.id}`,
          <Button key={`wlead-${item.id}`} plain onPress={() => focus($, ctx, lead)}>
            <Text color={SESSION_COLORS[lead.state]}>→</Text>
            <Text dimColor>{leadText.slice(1)}</Text>
          </Button>,
        )}
      {hasMark && sessionMark($, ctx, item.id, node.sessions)}
      {wayPad > 0 && fixed(ctx.els, `wwaypad-${item.id}`, <Text>{' '.repeat(wayPad)}</Text>)}
    </Box>
  )
}

/** A line under its Item for a board that belongs to it, with what it waits on the person for; pressing it opens it. */
function boardLine($: EngineInterface, ctx: Ctx, one: PlacedBoard, depth: number) {
  const { Box, Button, Text } = ctx.els
  const count = ctx.boardNeeds.get(one.id) ?? 0

  return (
    <Box key={`wboard-${one.id}`} flexDirection="row" paddingLeft={depth * 2}>
      <Button key={`wboardopen-${one.id}`} plain onPress={() => selectView($, one.id)}>
        <Text color="suggestion">{`▤ ${one.title}`}</Text>
        {count > 0 && (
          <Text color="warning" bold>
            {` ${count}`}
          </Text>
        )}
      </Button>
    </Box>
  )
}

/** One glyph in the color of the Sessions' most urgent state; pressing it opens the one active last. */
function sessionMark($: EngineInterface, ctx: Ctx, id: string, sessions: Session[]) {
  const { Button, Text } = ctx.els
  const state = SESSION_STATES.find(one => sessions.some(s => s.state === one)) ?? 'idle'
  const latest = [...sessions].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0] as Session

  return fixed(
    ctx.els,
    `wmarkbox-${id}`,
    <Button key={`wmark-${id}`} plain onPress={() => focus($, ctx, latest)}>
      <Text color={SESSION_COLORS[state]}>●</Text>
    </Button>,
  )
}

/**
 * A Session's line, pressed anywhere to bring the session to the front, and once its toggle is pressed open, the
 * Sessions it coordinates beneath it. A Session can be drawn under its Item and under its Coordinator at once, so its
 * keys carry `where` it is drawn.
 */
function sessionLines($: EngineInterface, ctx: Ctx, session: Session, depth: number, where: string, seen: Set<string>): RenderNode[] {
  const { Box, Button, Text } = ctx.els
  const children = (ctx.tree.coordinated.get(session.id) ?? []).filter(child => !seen.has(child.id))
  const at = `${where}-${session.id}`
  const isOpen = ctx.opened.has(at)
  const parts: Part[] = [
    { text: '●', color: SESSION_COLORS[session.state] },
    ...(ctx.self?.id === session.id ? [{ text: 'here', color: 'claude' as const, bold: true }] : []),
    { text: session.state.padEnd(STATE_WIDTH), color: SESSION_COLORS[session.state], dimColor: session.state === 'idle' },
  ]
  const title = session.label
  const room = ctx.columns - depth * 2 - 2
  const out: RenderNode[] = [
    <Box key={`wsess-${at}`} flexDirection="row" columnGap={1} paddingLeft={depth * 2}>
      {children.length > 0 ? (
        <Button key={`wstoggle-${at}`} label={isOpen ? '▾' : '▸'} plain dimColor onPress={toggle($, ctx.opened, at)} />
      ) : (
        fixed(ctx.els, `wsdot-${at}`, <Text dimColor>·</Text>)
      )}
      <Button key={`wsfocus-${at}`} plain onPress={() => focus($, ctx, session)}>
        {spans(ctx.els, fitLine(parts, { text: title, dimColor: true }, room))}
      </Button>
    </Box>,
  ]
  if (!isOpen) return out
  const below = new Set([...seen, session.id])
  for (const child of children) out.push(...sessionLines($, ctx, child, depth + 1, session.id, below))

  return out
}

function artifactLine($: EngineInterface, ctx: Ctx, artifact: Artifact, depth: number) {
  const { Box, Text } = ctx.els
  const tag = TAGS[artifact.status]

  return (
    <Box key={`wart-${artifact.id}`} flexDirection="row" columnGap={1} paddingLeft={depth * 2}>
      {fixed(ctx.els, `wadot-${artifact.id}`, <Text dimColor>·</Text>)}
      {fixed(
        ctx.els,
        `watag-${artifact.id}`,
        <Text color={tag.color} dimColor={artifact.status === 'done' || undefined}>
          {tag.tag.padEnd(TAG_WIDTH)}
        </Text>,
      )}
      {fixed(ctx.els, `walink-${artifact.id}`, link(ctx.els, artifact.url, artifact.tag, { dimColor: true }))}
      <Text dimColor wrap="truncate-end">
        {artifact.note ? `${artifact.title}: ${artifact.note}` : artifact.title}
      </Text>
    </Box>
  )
}

/** Sessions and open pull requests that match no Item, folded under a heading that counts each, so none is invisible. */
export function unplaced($: EngineInterface, ctx: Ctx, tree: Tree): RenderNode | undefined {
  const { Box, Button, Text } = ctx.els
  const { sessions, artifacts } = tree.unplaced
  if (sessions.length + artifacts.length === 0) return undefined
  const isOpen = ctx.doneShown.has('unplaced')
  const counts = [counted(sessions.length, 'session'), counted(artifacts.length, 'pull request')].filter(Boolean)

  return (
    <Box key="unplaced" flexDirection="column" marginTop={1}>
      <Button key="wunplaced" plain onPress={toggle($, ctx.doneShown, 'unplaced')}>
        <Text dimColor bold>
          {`${isOpen ? '▾' : '▸'} Unplaced`}
        </Text>{' '}
        <Text dimColor>{counts.join(' · ')}</Text>
      </Button>
      {isOpen && sessions.flatMap(s => sessionLines($, ctx, s, 1, 'unplaced', new Set()))}
      {isOpen && artifacts.map(a => artifactLine($, ctx, a, 1))}
    </Box>
  )
}

/** What a pressed-open Item shows above its children: only its links, one a line, since its details live behind them. */
function details($: EngineInterface, ctx: Ctx, node: Node): RenderNode | undefined {
  const { Box, Button } = ctx.els
  const { item } = node
  if (item.links.length === 0) return undefined
  const room = ctx.columns - (node.depth * 2 + 2)
  const buttons: RenderNode[] = item.links.map((link, i) => (
    <Button
      key={`wlink-${item.id}-${i}`}
      plain
      onPress={async () => {
        ctx.w.notice = await openUrl($, link.url)
        $.ui.invalidate('ui.render')
      }}
    >
      {spans(ctx.els, fitLine([{ text: '↗', color: 'suggestion' }], { text: link.label || sourceLabel(link.url, ctx.w.labels), color: 'suggestion' }, room))}
    </Button>
  ))

  return (
    <Box key={`wmore-${item.id}`} flexDirection="column" marginLeft={node.depth * 2 + 2}>
      {buttons}
    </Box>
  )
}
