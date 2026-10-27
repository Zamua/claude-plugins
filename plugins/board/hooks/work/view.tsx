import type { Color, EngineInterface, RenderNode } from 'claude-code'

import { ago, dueOf, fixed, link, openUrl, refreshJson, sourceLabel, stamp } from '../kit'
import type { Els, View } from '../kit'
import { paneWidth, selectView } from '../pane'
import { buildTree, needsTotal, pathTo, qualify, SESSION_STATES } from './model'
import type { Artifact, Node, Period, Session, SessionState, Status, Tree } from './model'
import { focusSession, liveNow, refreshLive } from './sessions'
import type { Live } from './sessions'
import { isVersion2, itemsAndLinks } from './sources/file'
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

let board: WorkBoard | undefined
// What the person pressed open, for the session `pressedFor` names
const opened = new Set<string>()
const doneShown = new Set<string>()
let pressedFor = ''
// The session whose own Item the view has opened down to, once
let placedFor = ''
let drawnAt = 0

export function configureWork(spec: WorkSpec | undefined, home: string, labels: Record<string, string> = {}) {
  if (!spec) {
    board = undefined
    return
  }
  const unknown = Object.keys(spec).filter(key => !SPEC_KEYS.has(key))
  board = {
    spec,
    path: spec.path.startsWith('~/') ? home + spec.path.slice(1) : spec.path,
    state: {},
    warnings: unknown.length > 0 ? [`boards.json: ${spec.id} has keys nothing reads: ${unknown.join(', ')}.`] : [],
    labels,
  }
}

export const currentWork = () => board

/** The tree the local file holds now, with the Sessions and Artifacts last listed, or why there is none. */
export function workTree(file: unknown, live: Live = liveNow()): { tree?: Tree; error?: string } {
  if (file === undefined) return {}
  if (!isVersion2(file)) return { error: 'This board is in the old format. Run /board work migrate to move it into the work model.' }
  const { items, links } = itemsAndLinks(file as LocalFile)
  const root = (file as LocalFile).root

  return { tree: buildTree(items, links, live.sessions, live.artifacts, typeof root === 'string' ? root : undefined) }
}

export async function workRefresh($: EngineInterface, force = false) {
  if (!board) return
  const fileChanged = await refreshJson($, board.state, board.path)
  const isShown = force || (await $.clock.now()) - drawnAt < SHOWN_MS
  const liveChanged = isShown && (await refreshLive($, board.spec, force))
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
function rootOf(file: unknown, tree: Tree): { id: string; session?: Session } | undefined {
  const id = (file as LocalFile | undefined)?.root
  if (typeof id !== 'string') return undefined
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
async function openWorkAt($: EngineInterface, id: string) {
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
  const root = rootOf(w.state.value, tree)
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

type Ctx = { els: Els; now: number; tree: Tree; self?: Session; columns: number }

type Part = { text: string; color?: Color; dimColor?: boolean; bold?: boolean }

const counted = (n: number, noun: string) => (n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`)

/**
 * `parts`, then `title` cut to fit, joined by single spaces into at most `room` cells. A Button cannot cut its own
 * text at the pane's edge, so a whole row can be one only once it is cut to fit.
 */
function fitLine(parts: Part[], title: Part, room: number): Part[] {
  const used = parts.reduce((n, part) => n + [...part.text].length + 1, 0)
  const left = Math.max(1, room - used)
  const chars = [...title.text]
  const text = chars.length <= left ? title.text : `${chars.slice(0, left - 1).join('')}…`

  return [...parts, { ...title, text }]
}

function spans(els: Els, parts: Part[]): RenderNode[] {
  const { Text } = els

  return parts.flatMap((part, at) => [
    ...(at > 0 ? [' '] : []),
    <Text color={part.color} dimColor={part.dimColor || undefined} bold={part.bold || undefined}>
      {part.text}
    </Text>,
  ])
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
      const { Box, Text } = els
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
      // One cell spare, so a row that fits exactly does not reach the pane's edge
      const ctx: Ctx = { els, now, tree, columns: paneWidth() - 1, ...(self.session && { self: self.session }) }
      const at = Date.parse((w.state.value as LocalFile).updated_at ?? '')
      const fresh = readError ?? (Number.isNaN(at) ? '' : `Updated ${ago(now - at)}`)
      const notes = [...w.warnings, ...tree.warnings, ...liveNow().errors]
      const root = rootOf(w.state.value, tree)
      const head = root ? (
        <Box key="whead" flexDirection="row" columnGap={1} paddingX={1}>
          {rootMark($, w, els, root, 'wroot')}
          <Box key="stamp" flexGrow={1} justifyContent="flex-end">
            <Text color={readError ? 'error' : undefined} dimColor={!readError || undefined}>
              {fresh}
            </Text>
          </Box>
        </Box>
      ) : (
        fresh !== '' && stamp(els, fresh, readError !== undefined)
      )

      return (
        <Box key="work-view" flexDirection="column">
          {head}
          {tree.outcomes.length + tree.responsibilities.length === 0 && (
            <Text dimColor wrap="wrap">
              Nothing tracked yet. Claude adds work here with {WORK_TOOL}.
            </Text>
          )}
          {tree.outcomes.length > 0 && (
            <Box key="outcomes" flexDirection="column">
              <Text dimColor bold>
                Outcomes
              </Text>
              {level(ctx, 'top-outcomes', tree.outcomes)}
            </Box>
          )}
          {tree.responsibilities.length > 0 && (
            <Box key="responsibilities" flexDirection="column" marginTop={1}>
              <Text dimColor bold>
                Responsibilities
              </Text>
              {level(ctx, 'top-responsibilities', tree.responsibilities)}
            </Box>
          )}
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
        </Box>
      )
    },
  }

  /** One level's open lines, then its finished ones folded behind a count. */
  function level(ctx: Ctx, key: string, nodes: Node[]): RenderNode[] {
    const { Box, Button } = ctx.els
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
    out.push(...node.sessions.flatMap(s => sessionLines(ctx, s, node.depth + 1, item.id, new Set())))
    out.push(...node.artifacts.map(a => artifactLine(ctx, a, node.depth + 1)))
    if (node.children.length > 0) out.push(...level(ctx, item.id, node.children))

    return out
  }

  /** One line per Item, pressed anywhere to open or fold it; its sessions' mark sits apart at the right edge. */
  function row(ctx: Ctx, node: Node, isOpen: boolean) {
    const { Box, Text, Button } = ctx.els
    const { item } = node
    const tag = TAGS[node.shown]
    const quiet = node.shown === 'done'
    const hasMore =
      node.children.length > 0 ||
      node.sessions.length > 0 ||
      node.artifacts.length > 0 ||
      Boolean(item.detail) ||
      item.links.length > 0
    const glyph = !hasMore ? '·' : isOpen ? '▾' : '▸'
    const due = item.target ? dueOf(item.target, item.targetLabel, ctx.now) : undefined
    const showKind = node.depth === 0 || node.children.length > 0
    const hasMark = node.sessions.length > 0
    const parts: Part[] = [
      { text: glyph, dimColor: true },
      { text: tag.tag.padEnd(TAG_WIDTH), color: tag.color, dimColor: quiet },
      ...(node.needsCount > 0 ? [{ text: String(node.needsCount), color: 'warning' as const, bold: true }] : []),
      ...(due ? [due.color ? { text: due.text, color: due.color } : { text: due.text, dimColor: true }] : []),
      ...(showKind ? [{ text: item.kind, dimColor: true }] : []),
      ...(item.ref !== undefined ? [{ text: `#${item.ref}`, dimColor: true }] : []),
    ]
    const room = ctx.columns - node.depth * 2 - (hasMark ? 2 : 0)
    const content = spans(ctx.els, fitLine(parts, { text: item.title, dimColor: quiet }, room))

    return (
      <Box key={`wrow-${item.id}`} flexDirection="row" paddingLeft={node.depth * 2}>
        {hasMore ? (
          <Button key={`wtoggle-${item.id}`} plain onPress={toggle($, opened, item.id)}>
            {content}
          </Button>
        ) : (
          <Text>{content}</Text>
        )}
        {hasMark && <Box key={`wgap-${item.id}`} flexGrow={1} />}
        {hasMark && sessionMark(ctx, item.id, node.sessions)}
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
    const title = session.summary ? `${session.label}: ${session.summary.split('\n')[0]}` : session.label
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

  /** What a pressed-open Item shows above its children: its detail and links. */
  function details(ctx: Ctx, node: Node): RenderNode | undefined {
    const { Box, Button, Markdown, Text } = ctx.els
    const { item } = node
    const buttons: RenderNode[] = item.links.map((link, i) => (
      <Button
        key={`wlink-${item.id}-${i}`}
        label={link.label || sourceLabel(link.url, w.labels)}
        plain
        dimColor
        onPress={async () => {
          w.notice = await openUrl($, link.url)
          $.ui.invalidate('ui.render')
        }}
      />
    ))
    if (!item.detail && buttons.length === 0) return undefined

    return (
      <Box key={`wmore-${item.id}`} flexDirection="column" paddingLeft={node.depth * 2 + 2}>
        {item.detail && <Markdown key={`wdetail-${item.id}`} dimColor text={item.detail} />}
        {buttons.length > 0 && (
          <Box key={`wlinks-${item.id}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
            {buttons.flatMap((b, i) => [...(i > 0 ? [<Text dimColor>·</Text>] : []), b])}
          </Box>
        )}
      </Box>
    )
  }
}
