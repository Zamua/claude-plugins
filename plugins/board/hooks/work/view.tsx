import type { Color, EngineInterface, On, RenderNode } from 'claude-code'

import { ago, dayOf, dueOf, fitLine, fixed, link, openUrl, refreshJson, sourceLabel, span, spans } from '../kit'
import type { Els, Part, View } from '../kit'
import { PANE, paneFocused, paneWidth, selectView } from '../pane'
import { buildTree, followSessions, inPeriod, isLate, mergeItems, needsTotal, pathTo, qualify, rank, sectionsOf, SESSION_STATES } from './model'
import type { Artifact, Node, Period, Session, SessionState, Status, Tree } from './model'
import { focusSession, liveNow, refreshLive, rememberItems } from './sessions'
import type { Live } from './sessions'
import { agentsOf, hiddenOf, isVersion2, itemsAndLinks, sectionMapOf, sectionNamesOf, withEtas } from './sources/file'
import type { LocalFile, LocalState } from './sources/file'

export const WORK_TOOL = 'mcp__board__work'
/** Names the Item a started session serves, in that session's environment; `$.env.get` spells it out. */
export const START_ENV = 'BOARD_WORK_ITEM'

/** A `model` board as `boards.json` names it. */
export type WorkSpec = {
  id: string
  title?: string
  path: string
  sources?: Record<string, unknown>
  hosts?: Record<string, unknown>
  harnesses?: Record<string, unknown>
  periods?: Period[]
  /** Every other board's file, by board id; set from `boards.json`, not written there. */
  boardPaths?: Record<string, string>
}

export type WorkBoard = {
  spec: WorkSpec
  path: string
  state: LocalState
  /** Lines about the config itself, such as a key nothing reads. */
  warnings: string[]
  /** Short names for link hosts, from `boards.json`. */
  labels: Record<string, string>
  /** The last press that failed, until the next one succeeds. */
  notice?: string | undefined
}

const SPEC_KEYS = new Set(['id', 'title', 'layout', 'path', 'sources', 'hosts', 'harnesses', 'periods'])
const POLL_MS = 15_000
// Sessions are listed only while someone looks at the view
const SHOWN_MS = 60_000

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

/** A board that belongs to one Item: its tab shows only in the sessions under that Item, and a line under the Item opens it. */
export type PlacedBoard = { id: string; title: string; under: string }

let board: WorkBoard | undefined
let placed: PlacedBoard[] = []
// What each placed board waits on the person for, by board id, as the pane counted it before drawing
let placedNeeds = new Map<string, number>()
// What the person pressed open, for the session `pressedFor` names
const opened = new Set<string>()
const doneShown = new Set<string>()
let pressedFor = ''
// The session whose own Item the view has opened down to, once
let placedFor = ''
let drawnAt = 0
// The Period the view is cut to, by name; empty shows every Item
let period = ''
let isPeriodOpen = false
let wasFocused = false

export function configureWork(
  spec: WorkSpec | undefined,
  home: string,
  labels: Record<string, string> = {},
  boardPaths: Record<string, string> = {},
) {
  if (!spec) {
    board = undefined
    return
  }
  const unknown = Object.keys(spec).filter(key => !SPEC_KEYS.has(key))
  board = {
    spec: { ...spec, boardPaths },
    path: spec.path.startsWith('~/') ? home + spec.path.slice(1) : spec.path,
    state: {},
    warnings: unknown.length > 0 ? [`boards.json: ${spec.id} has keys nothing reads: ${unknown.join(', ')}.`] : [],
    labels,
  }
}

export const currentWork = () => board

/** The boards that belong to an Item, each drawn as a line under it. */
export function placeBoards(boards: PlacedBoard[]) {
  placed = boards.map(one => ({ ...one, under: qualify(one.under) }))
}

export function countPlaced(needs: Map<string, number>) {
  placedNeeds = needs
}

/**
 * Whether this session works under `under`: its own Item sits at or below it, or the Item of a session coordinating it,
 * up the chain, does.
 */
export async function isWithin($: EngineInterface, under: string): Promise<boolean> {
  const w = board
  if (!w) return false
  if (liveNow().at === 0) await refreshLive($, w.spec)
  const tree = workTree(w.state.value).tree
  if (!tree) return false
  const target = qualify(under)
  const self = await selfOf($, tree)
  const items = self.item ? [self.item] : []
  const seen = new Set<string>()
  for (let at = self.session?.id; at && !seen.has(at); at = tree.coordinatorOf.get(at)) {
    seen.add(at)
    const up = tree.coordinatorOf.get(at)
    const item = up ? tree.sessionItem.get(up) : undefined
    if (item) items.push(item)
  }

  return items.some(item => pathTo(tree, item).some(one => one.id === target))
}

/** The tree the local file holds now, with the Sessions and Artifacts last listed, or why there is none. */
export function workTree(file: unknown, live: Live = liveNow()): { tree?: Tree; error?: string } {
  if (file === undefined) return {}
  if (!isVersion2(file)) return { error: 'This board is in the old format. Run /board work migrate to move it into the work model.' }
  const local = file as LocalFile
  const { items, links: held } = itemsAndLinks(local)
  const { links, root } = followSessions(held, typeof local.root === 'string' ? local.root : undefined, agentsOf(local), live.sessions)
  const all = withEtas(mergeItems(items, live.items), local)
  const tree = buildTree(all, links, live.sessions, live.artifacts, root, live.past, hiddenOf(local))
  const titles = sectionNamesOf(local)

  return { tree: titles.length > 0 ? { ...tree, sections: sectionsOf(tree, titles, sectionMapOf(local)) } : tree }
}

function periodsOf(spec: WorkSpec): Period[] {
  return (Array.isArray(spec.periods) ? spec.periods : []).filter(
    one => one && typeof one.name === 'string' && typeof one.start === 'string' && typeof one.end === 'string',
  )
}

/** Cuts the view to the Period named, or to every Item for `all`; a name no Period has comes back as why. */
export function choosePeriod(name: string): string | undefined {
  const periods = board ? periodsOf(board.spec) : []
  if (name.toLowerCase() === 'all') {
    period = ''
    return undefined
  }
  const found = periods.find(one => one.name.toLowerCase() === name.toLowerCase())
  if (!found) {
    return periods.length > 0
      ? `No period ${name}. Periods: ${periods.map(one => one.name).join(', ')}, or all.`
      : 'boards.json names no periods for the work board.'
  }
  period = found.name

  return undefined
}

/** Folds the open Period list on a press or a focus move anywhere but the list and its box, as a click off it. */
function foldPeriods($: EngineInterface, element: string | undefined) {
  if (!isPeriodOpen || (element !== undefined && element.startsWith('wper'))) return
  isPeriodOpen = false
  $.ui.invalidate('ui.render')
}

export function workViewHooks(on: On) {
  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    foldPeriods($, e.element)

    return next(e)
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    foldPeriods($, e.element)

    return next(e)
  })
}

export async function workRefresh($: EngineInterface, force = false) {
  if (!board) return
  const fileChanged = await refreshJson($, board.state, board.path)
  const isShown = force || (await $.clock.now()) - drawnAt < SHOWN_MS
  const liveChanged = isShown && (await refreshLive($, board.spec, force))
  if (liveChanged) {
    const tree = workTree(board.state.value).tree
    if (tree) await rememberItems($, tree.sessionItem)
  }
  if (fileChanged || liveChanged) $.ui.invalidate('ui.render')
}

export async function workStart($: EngineInterface) {
  await workRefresh($)
  $.clock.every(POLL_MS, () => workRefresh($))
}

function forSession(sessionId: string) {
  if (pressedFor === sessionId) return
  opened.clear()
  doneShown.clear()
  pressedFor = sessionId
}

const openPath = (tree: Tree, id: string) => {
  for (const item of pathTo(tree, id)) opened.add(item.id)
}

/** The root session the local file names, with the Session a Host lists for it while it runs. */
function rootOf(tree: Tree): { id: string; session?: Session } | undefined {
  const id = tree.root
  if (id === undefined) return undefined
  const session = tree.sessions.get(id)

  return session ? { id, session } : { id }
}

/** This session as a Host lists it, and the Item it serves: its attachment, else the Item it was started for. */
async function selfOf($: EngineInterface, tree: Tree): Promise<{ session?: Session; item?: string }> {
  const harnessId = await $.session.id()
  const session = [...tree.sessions.values()].find(one => one.harnessId === harnessId)
  const attached = session ? tree.sessionItem.get(session.id) : undefined
  const started = await $.env.get('BOARD_WORK_ITEM')
  const item = attached ?? (started && tree.byId.has(qualify(started)) ? qualify(started) : undefined)

  return { ...(session && { session }), ...(item && { item }) }
}

/** A one-glyph mark that brings the root session to the front, dim once it has ended. */
function rootMark($: EngineInterface, w: WorkBoard, els: Els, root: { session?: Session }, key: string) {
  const { Button, Text } = els
  const press = async () => {
    w.notice = root.session ? await focusSession($, root.session) : 'The root session is not running.'
    $.ui.invalidate('ui.render')
  }

  return fixed(
    els,
    `${key}box`,
    <Button key={key} plain onPress={press}>
      <Text color="claude" dimColor={!root.session || undefined}>
        ⌂
      </Text>{' '}
      <Text dimColor>{root.session?.label ?? 'root'}</Text>
    </Button>,
  )
}

/** Switches the pane to the work view with the path down to `id` open. */
export async function openWorkAt($: EngineInterface, id: string) {
  const w = board
  const tree = w && workTree(w.state.value).tree
  if (!w || !tree) return
  forSession(await $.session.id())
  openPath(tree, id)
  await selectView($, w.spec.id)
}

/**
 * The session view's breadcrumb: the root mark, then the Items from the top of the tree down to this session's, cut
 * from the left, and a press that opens the work view there.
 */
export async function workBreadcrumb($: EngineInterface, els: Els): Promise<RenderNode | undefined> {
  const w = board
  if (!w) return undefined
  drawnAt = await $.clock.now()
  if (liveNow().at === 0) await refreshLive($, w.spec)
  const tree = workTree(w.state.value).tree
  if (!tree) return undefined
  const { item } = await selfOf($, tree)
  const root = rootOf(tree)
  if (!item && !root) return undefined
  const { Box, Button, Text } = els
  const path = item ? pathTo(tree, item) : []

  return (
    <Box key="crumbs" flexDirection="row" columnGap={1}>
      {root && rootMark($, w, els, root, 'crumbroot')}
      {path.length > 0 && (
        <Text dimColor wrap="truncate-start">
          {path.map(one => one.title).join(' › ')}
        </Text>
      )}
      {item &&
        fixed(els, 'crumbopenbox', <Button key="crumbopen" label="↗" plain dimColor onPress={() => openWorkAt($, item)} />)}
    </Box>
  )
}

function toggle($: EngineInterface, set: Set<string>, key: string) {
  return async () => {
    if (set.has(key)) set.delete(key)
    else set.add(key)
    $.ui.invalidate('ui.render')
  }
}

/** `shows` holds the Items a chosen Period draws; absent, every Item draws. */
type Ctx = {
  els: Els
  now: number
  tree: Tree
  self?: Session
  columns: number
  shows?: Set<string>
  /** What each placed board waits on the person for, by board id. */
  boardNeeds: Map<string, number>
}

const counted = (n: number, noun: string) => (n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`)
const widthOf = (parts: Part[]) => parts.reduce((n, part, at) => n + [...part.text].length + (at > 0 ? 1 : 0), 0)
const cut = (text: string, width: number) => ([...text].length <= width ? text : `${[...text].slice(0, width - 1).join('')}…`)

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
function ranked(nodes: Node[], now: number): Node[] {
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


export function workView($: EngineInterface, w: WorkBoard): View {
  const treeNow = () => workTree(w.state.value).tree

  return {
    id: w.spec.id,
    title: w.spec.title ?? w.spec.id,
    scope: 'shared',
    guide: { tool: WORK_TOOL, text: `keep its ${w.spec.id} view current with ${WORK_TOOL}` },
    onShow: () => workRefresh($, true),
    opensAtStart: async () => Boolean(await $.env.get('BOARD_WORK_ITEM')),
    isAvailable: async () => !w.state.isMissing,
    needs: async () => {
      const tree = treeNow()
      return tree ? needsTotal(tree) : 0
    },
    render: async els => {
      const { Box, Button, Text } = els
      const sessionId = await $.session.id()
      forSession(sessionId)
      const now = await $.clock.now()
      drawnAt = now
      const { tree, error } = workTree(w.state.value)
      const readError = w.state.error ? `Could not read the work board: ${w.state.error}` : undefined
      if (!tree) {
        const why = readError ?? error ?? (w.state.isMissing ? `No work board yet at ${w.path}.` : 'Reading the work board.')

        return (
          <Text dimColor wrap="wrap">
            {why}
          </Text>
        )
      }
      const self = await selfOf($, tree)
      if (placedFor !== sessionId && self.item) {
        openPath(tree, self.item)
        placedFor = sessionId
      }
      const periods = periodsOf(w.spec)
      const chosen = periods.find(one => one.name === period)
      // A click outside the pane takes the keyboard back from it, which folds the Period list too
      if (wasFocused && !paneFocused()) isPeriodOpen = false
      wasFocused = paneFocused()
      // The view keeps a cell clear of the pane's right edge, and one more spare so a row that fits exactly stops short
      const ctx: Ctx = {
        els,
        now,
        tree,
        columns: paneWidth() - 2,
        boardNeeds: placedNeeds,
        ...(self.session && { self: self.session }),
        ...(chosen && { shows: inPeriod(tree, chosen) }),
      }
      const at = Date.parse((w.state.value as LocalFile).updated_at ?? '')
      const fresh = readError ?? (Number.isNaN(at) ? '' : `Updated ${ago(now - at)}`)
      const notes = [...w.warnings, ...tree.warnings, ...liveNow().errors]
      const root = rootOf(tree)
      const shown = (nodes: Node[]) => (ctx.shows ? nodes.filter(n => ctx.shows?.has(n.item.id)) : nodes)
      const top = ranked(shown([...tree.outcomes, ...tree.responsibilities]), now)
      const sections = (tree.sections ?? [])
        .map(section => ({ title: section.title, nodes: ranked(shown(section.nodes), now) }))
        .filter(section => section.nodes.length > 0)
      const inbox = shown(tree.inbox)
      const box =
        periods.length > 0 ? (
          <Button
            key="wperiod"
            label={`Period: ${chosen?.name ?? 'all'} ${isPeriodOpen ? '▴' : '▾'}`}
            onPress={() => {
              isPeriodOpen = !isPeriodOpen
              $.ui.invalidate('ui.render')
            }}
          />
        ) : undefined
      const head = (root || box || fresh !== '') && (
        <Box key="whead" flexDirection="row" columnGap={1} paddingLeft={1} marginBottom={1}>
          {root && rootMark($, w, els, root, 'wroot')}
          {box}
          <Box key="stamp" flexGrow={1} justifyContent="flex-end">
            <Text color={readError ? 'error' : undefined} dimColor={!readError || undefined}>
              {fresh}
            </Text>
          </Box>
        </Box>
      )

      return (
        <Box key="work-view" flexDirection="column" paddingRight={1}>
          {head}
          {top.length + inbox.length === 0 && (
            <Text dimColor wrap="wrap">
              {chosen ? `Nothing dated in ${chosen.name}.` : `Nothing tracked yet. Claude adds work here with ${WORK_TOOL}.`}
            </Text>
          )}
          {inbox.length > 0 && (
            <Box key="inbox" flexDirection="column" marginBottom={1}>
              <Text dimColor bold>
                Inbox
              </Text>
              {level(ctx, 'top-inbox', inbox)}
            </Box>
          )}
          {top.length > 0 && !tree.sections && (
            <Box key="top" flexDirection="column">
              {level(ctx, 'top', top)}
            </Box>
          )}
          {sections.map(section => {
            const key = `sec-${section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

            return (
              <Box key={`w${key}`} flexDirection="column" marginBottom={1}>
                <Text dimColor bold>
                  {section.title}
                </Text>
                {level(ctx, key, section.nodes)}
              </Box>
            )
          })}
          {unplaced(ctx, tree)}
          {w.notice && (
            <Text key="work-notice" color="yellow" wrap="wrap">
              {w.notice}
            </Text>
          )}
          {notes.map(note => (
            <Text dimColor wrap="wrap">
              {note}
            </Text>
          ))}
          {isPeriodOpen && periods.length > 0 && periodList(els, periods, root)}
        </Box>
      )
    },
  }

  /**
   * The Periods to cut the view to, in a list over the rows below the box, under its left edge. Every line is padded
   * to the list's width, since cells it leaves blank show the rows beneath.
   */
  function periodList(els: Els, periods: Period[], root: { session?: Session } | undefined) {
    const { Box, Button, Text } = els
    const options = [{ name: '', label: 'all' }, ...periods.map(one => ({ name: one.name, label: one.name }))]
    const inner = Math.max(...options.map(one => [...one.label].length)) + 2
    // The root mark draws as `⌂ label` and a cell parts it from the box
    const before = root ? 2 + [...(root.session?.label ?? 'root')].length + 1 : 0

    return (
      <Box key="wperiod-list" position="absolute" top={1} left={before} flexDirection="column" borderStyle="round" borderColor="inactive">
        {options.map((one, at) => {
          const isOn = one.name === period

          return (
            <Button
              key={one.name ? `wper-${at}` : 'wper-all'}
              plain
              onPress={() => {
                period = one.name
                isPeriodOpen = false
                $.ui.invalidate('ui.render')
              }}
            >
              <Text color={isOn ? 'claude' : undefined}>{` ${isOn ? '●' : '○'} `}</Text>
              <Text>{one.label.padEnd(inner)}</Text>
            </Button>
          )
        })}
      </Box>
    )
  }

  /** One level's open lines, then its finished ones folded behind a count. */
  function level(ctx: Ctx, key: string, all: Node[]): RenderNode[] {
    const { Box, Button } = ctx.els
    const nodes = ctx.shows ? all.filter(n => ctx.shows?.has(n.item.id)) : all
    const open = nodes.filter(n => n.shown !== 'done')
    const done = nodes.filter(n => n.shown === 'done')
    const out = open.flatMap(n => lines(ctx, n))
    if (done.length === 0) return out
    out.push(
      <Box key={`wdonebox-${key}`} paddingLeft={(nodes[0]?.depth ?? 0) * 2}>
        <Button key={`wdone-${key}`} label={`✓ ${done.length} done`} plain dimColor onPress={toggle($, doneShown, key)} />
      </Box>,
    )
    if (doneShown.has(key)) out.push(...done.flatMap(n => lines(ctx, n)))

    return out
  }

  function lines(ctx: Ctx, node: Node): RenderNode[] {
    const { item } = node
    const isOpen = opened.has(item.id)
    const out: RenderNode[] = [row(ctx, node, isOpen)]
    if (!isOpen) return out
    const more = details(ctx, node)
    if (more) out.push(more)
    out.push(...placed.filter(one => one.under === item.id).map(one => boardLine(ctx, one, node.depth + 1)))
    out.push(...node.sessions.flatMap(s => sessionLines(ctx, s, node.depth + 1, item.id, new Set())))
    out.push(...node.artifacts.map(a => artifactLine(ctx, a, node.depth + 1)))
    if (node.children.length > 0) out.push(...level(ctx, item.id, node.children))

    return out
  }

  /**
   * One line per Item, pressed anywhere to open or fold it: its status, its title cut to the room left, then fixed
   * columns pinned to the right edge at every depth: how many things need the person, when it is due, and a way to its
   * session. A top-level Item's way is the session that leads it, by label; a deeper one's is a mark. Every cell is
   * written, as spaces where a column is empty, since a row that shrinks otherwise keeps the old row's letters there.
   */
  function row(ctx: Ctx, node: Node, isOpen: boolean) {
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
        <Button key={`wtoggle-${item.id}`} plain onPress={toggle($, opened, item.id)}>
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
            <Button key={`wlead-${item.id}`} plain onPress={() => focus(lead)}>
              <Text color={SESSION_COLORS[lead.state]}>→</Text>
              <Text dimColor>{leadText.slice(1)}</Text>
            </Button>,
          )}
        {hasMark && sessionMark(ctx, item.id, node.sessions)}
        {wayPad > 0 && fixed(ctx.els, `wwaypad-${item.id}`, <Text>{' '.repeat(wayPad)}</Text>)}
      </Box>
    )
  }

  /** A line under its Item for a board that belongs to it, with what it waits on the person for; pressing it opens it. */
  function boardLine(ctx: Ctx, one: PlacedBoard, depth: number) {
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
  function sessionMark(ctx: Ctx, id: string, sessions: Session[]) {
    const { Button, Text } = ctx.els
    const state = SESSION_STATES.find(one => sessions.some(s => s.state === one)) ?? 'idle'
    const latest = [...sessions].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0] as Session

    return fixed(
      ctx.els,
      `wmarkbox-${id}`,
      <Button key={`wmark-${id}`} plain onPress={() => focus(latest)}>
        <Text color={SESSION_COLORS[state]}>●</Text>
      </Button>,
    )
  }

  async function focus(session: Session) {
    w.notice = await focusSession($, session)
    $.ui.invalidate('ui.render')
  }

  /**
   * A Session's line, pressed anywhere to bring the session to the front, and once its toggle is pressed open, the
   * Sessions it coordinates beneath it. A Session can be drawn under its Item and under its Coordinator at once, so its
   * keys carry `where` it is drawn.
   */
  function sessionLines(ctx: Ctx, session: Session, depth: number, where: string, seen: Set<string>): RenderNode[] {
    const { Box, Button, Text } = ctx.els
    const children = (ctx.tree.coordinated.get(session.id) ?? []).filter(child => !seen.has(child.id))
    const at = `${where}-${session.id}`
    const isOpen = opened.has(at)
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
          <Button key={`wstoggle-${at}`} label={isOpen ? '▾' : '▸'} plain dimColor onPress={toggle($, opened, at)} />
        ) : (
          fixed(ctx.els, `wsdot-${at}`, <Text dimColor>·</Text>)
        )}
        <Button key={`wsfocus-${at}`} plain onPress={() => focus(session)}>
          {spans(ctx.els, fitLine(parts, { text: title, dimColor: true }, room))}
        </Button>
      </Box>,
    ]
    if (!isOpen) return out
    const below = new Set([...seen, session.id])
    for (const child of children) out.push(...sessionLines(ctx, child, depth + 1, session.id, below))

    return out
  }

  function artifactLine(ctx: Ctx, artifact: Artifact, depth: number) {
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
  function unplaced(ctx: Ctx, tree: Tree): RenderNode | undefined {
    const { Box, Button, Text } = ctx.els
    const { sessions, artifacts } = tree.unplaced
    if (sessions.length + artifacts.length === 0) return undefined
    const isOpen = doneShown.has('unplaced')
    const counts = [counted(sessions.length, 'session'), counted(artifacts.length, 'pull request')].filter(Boolean)

    return (
      <Box key="unplaced" flexDirection="column" marginTop={1}>
        <Button key="wunplaced" plain onPress={toggle($, doneShown, 'unplaced')}>
          <Text dimColor bold>
            {`${isOpen ? '▾' : '▸'} Unplaced`}
          </Text>{' '}
          <Text dimColor>{counts.join(' · ')}</Text>
        </Button>
        {isOpen && sessions.flatMap(s => sessionLines(ctx, s, 1, 'unplaced', new Set()))}
        {isOpen && artifacts.map(a => artifactLine(ctx, a, 1))}
      </Box>
    )
  }

  /** What a pressed-open Item shows above its children: only its links, one a line, since its details live behind them. */
  function details(ctx: Ctx, node: Node): RenderNode | undefined {
    const { Box, Button } = ctx.els
    const { item } = node
    if (item.links.length === 0) return undefined
    const room = ctx.columns - (node.depth * 2 + 2)
    const buttons: RenderNode[] = item.links.map((link, i) => (
      <Button
        key={`wlink-${item.id}-${i}`}
        plain
        onPress={async () => {
          w.notice = await openUrl($, link.url)
          $.ui.invalidate('ui.render')
        }}
      >
        {spans(ctx.els, fitLine([{ text: '↗', color: 'suggestion' }], { text: link.label || sourceLabel(link.url, w.labels), color: 'suggestion' }, room))}
      </Button>
    ))

    return (
      <Box key={`wmore-${item.id}`} flexDirection="column" marginLeft={node.depth * 2 + 2}>
        {buttons}
      </Box>
    )
  }
}
