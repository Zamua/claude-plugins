import type { Color, EngineInterface, RenderNode } from 'claude-code'

import { ago, dueOf, fixed, link, openUrl, refreshJson, sourceLabel, stamp } from '../kit'
import type { Els, View } from '../kit'
import { buildTree, needsTotal, SESSION_STATES } from './model'
import type { Artifact, Node, Period, Session, SessionState, Status, Tree } from './model'
import { focusSession, liveNow, refreshLive } from './sessions'
import type { Live } from './sessions'
import { isVersion2, itemsAndLinks } from './sources/file'
import type { LocalFile, LocalState } from './sources/file'

export const WORK_TOOL = 'mcp__board__work'

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

  return { tree: buildTree(items, links, live.sessions, live.artifacts) }
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

function toggle($: EngineInterface, set: Set<string>, key: string) {
  return async () => {
    if (set.has(key)) set.delete(key)
    else set.add(key)
    $.ui.invalidate('ui.render')
  }
}

type Ctx = { els: Els; now: number; tree: Tree }

export function workView($: EngineInterface, w: WorkBoard): View {
  const treeNow = () => workTree(w.state.value).tree

  return {
    id: w.spec.id,
    title: w.spec.title ?? w.spec.id,
    scope: 'shared',
    guide: { tool: WORK_TOOL, text: `keep its ${w.spec.id} view current with ${WORK_TOOL}` },
    onShow: () => workRefresh($, true),
    isAvailable: async () => !w.state.isMissing,
    needs: async () => {
      const tree = treeNow()
      return tree ? needsTotal(tree) : 0
    },
    render: async els => {
      const { Box, Text } = els
      const sessionId = await $.session.id()
      if (pressedFor !== sessionId) {
        opened.clear()
        doneShown.clear()
        pressedFor = sessionId
      }
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
      const ctx: Ctx = { els, now, tree }
      const at = Date.parse((w.state.value as LocalFile).updated_at ?? '')
      const fresh = readError ?? (Number.isNaN(at) ? '' : `Updated ${ago(now - at)}`)
      const notes = [...w.warnings, ...tree.warnings, ...liveNow().errors]

      return (
        <Box key="work-view" flexDirection="column">
          {fresh !== '' && stamp(els, fresh, readError !== undefined)}
          {tree.outcomes.length + tree.responsibilities.length === 0 && (
            <Text dimColor wrap="wrap">
              Nothing tracked yet. Claude adds work here with {WORK_TOOL}.
            </Text>
          )}
          {level(ctx, 'top-outcomes', tree.outcomes)}
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

  function row(ctx: Ctx, node: Node, isOpen: boolean) {
    const { Box, Text, Button } = ctx.els
    const { item } = node
    const tag = TAGS[node.shown]
    const quiet = node.shown === 'done' || undefined
    const hasMore =
      node.children.length > 0 ||
      node.sessions.length > 0 ||
      node.artifacts.length > 0 ||
      Boolean(item.detail) ||
      item.links.length > 0
    const glyph = !hasMore ? '·' : isOpen ? '▾' : node.children.length > 0 ? '▸' : '›'
    const due = item.target ? dueOf(item.target, item.targetLabel, ctx.now) : undefined
    const showKind = node.depth === 0 || node.children.length > 0

    return (
      <Box key={`wrow-${item.id}`} flexDirection="row" columnGap={1} paddingLeft={node.depth * 2}>
        {hasMore ? (
          <Button key={`wtoggle-${item.id}`} label={glyph} plain dimColor onPress={toggle($, opened, item.id)} />
        ) : (
          fixed(ctx.els, `wdot-${item.id}`, <Text dimColor>{glyph}</Text>)
        )}
        {fixed(
          ctx.els,
          `wtag-${item.id}`,
          <Text color={tag.color} dimColor={quiet}>
            {tag.tag.padEnd(TAG_WIDTH)}
          </Text>,
        )}
        {node.needsCount > 0 &&
          fixed(
            ctx.els,
            `wneeds-${item.id}`,
            <Text color="warning" bold>
              {String(node.needsCount)}
            </Text>,
          )}
        {due && fixed(ctx.els, `wdue-${item.id}`, <Text color={due.color} dimColor={!due.color || undefined}>{due.text}</Text>)}
        {showKind && fixed(ctx.els, `wkind-${item.id}`, <Text dimColor>{item.kind}</Text>)}
        {item.ref !== undefined && fixed(ctx.els, `wref-${item.id}`, <Text dimColor>{`#${item.ref}`}</Text>)}
        {node.sessions.length > 0 && sessionMark(ctx, item.id, node.sessions)}
        <Text dimColor={quiet} wrap="truncate-end">
          {item.title}
        </Text>
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
   * A Session's line, and once pressed open, the Sessions it coordinates beneath it. A Session can be drawn under its
   * Item and under its Coordinator at once, so its keys carry `where` it is drawn.
   */
  function sessionLines(ctx: Ctx, session: Session, depth: number, where: string, seen: Set<string>): RenderNode[] {
    const { Box, Button, Text } = ctx.els
    const children = (ctx.tree.coordinated.get(session.id) ?? []).filter(child => !seen.has(child.id))
    const at = `${where}-${session.id}`
    const isOpen = opened.has(at)
    const out: RenderNode[] = [
      <Box key={`wsess-${at}`} flexDirection="row" columnGap={1} paddingLeft={depth * 2}>
        {children.length > 0 ? (
          <Button key={`wstoggle-${at}`} label={isOpen ? '▾' : '▸'} plain dimColor onPress={toggle($, opened, at)} />
        ) : (
          fixed(ctx.els, `wsdot-${at}`, <Text dimColor>·</Text>)
        )}
        {sessionMark(ctx, at, [session])}
        {fixed(
          ctx.els,
          `wstate-${at}`,
          <Text color={SESSION_COLORS[session.state]} dimColor={session.state === 'idle' || undefined}>
            {session.state.padEnd(STATE_WIDTH)}
          </Text>,
        )}
        <Text dimColor wrap="truncate-end">
          {session.summary ? `${session.label}: ${session.summary.split('\n')[0]}` : session.label}
        </Text>
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

  /** Sessions and open pull requests that match no Item, folded behind a count so none is invisible. */
  function unplaced(ctx: Ctx, tree: Tree): RenderNode | undefined {
    const { Box, Button } = ctx.els
    const { sessions, artifacts } = tree.unplaced
    const count = sessions.length + artifacts.length
    if (count === 0) return undefined
    const isOpen = doneShown.has('unplaced')

    return (
      <Box key="unplaced" flexDirection="column" marginTop={1}>
        <Button key="wunplaced" label={`◦ ${count} unplaced`} plain dimColor onPress={toggle($, doneShown, 'unplaced')} />
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
