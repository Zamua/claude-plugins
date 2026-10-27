import type { Color, EngineInterface, RenderNode } from 'claude-code'

import { ago, dueOf, fixed, focusWorkspace, openUrl, refreshJson, sourceLabel, stamp } from '../kit'
import type { Els, View } from '../kit'
import { buildTree, needsTotal } from './model'
import type { Node, Period, Status, Tree } from './model'
import { isVersion2, itemsAndLinks } from './sources/file'
import type { LocalFile, LocalState } from './sources/file'

export const WORK_TOOL = 'mcp__board__work'

/** A `model` board as `boards.json` names it. */
export type WorkSpec = {
  id: string
  title?: string
  path: string
  sources?: Record<string, unknown>
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

const SPEC_KEYS = new Set(['id', 'title', 'layout', 'path', 'sources', 'periods'])
const POLL_MS = 15_000

const TAGS: Record<Status, { tag: string; color: Color }> = {
  needs: { tag: 'you', color: 'warning' },
  flight: { tag: 'now', color: 'success' },
  waiting: { tag: 'wait', color: 'permission' },
  next: { tag: 'next', color: 'suggestion' },
  watching: { tag: 'watch', color: 'suggestion' },
  done: { tag: 'done', color: 'inactive' },
}
const TAG_WIDTH = Math.max(...Object.values(TAGS).map(t => t.tag.length))

let board: WorkBoard | undefined
// What the person pressed open, for the session `pressedFor` names
const opened = new Set<string>()
const doneShown = new Set<string>()
let pressedFor = ''

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

/** The tree the local file holds now, or why there is none. */
export function workTree(file: unknown): { tree?: Tree; error?: string } {
  if (file === undefined) return {}
  if (!isVersion2(file)) return { error: 'This board is in the old format. Run /board work migrate to move it into the work model.' }
  const { items, links } = itemsAndLinks(file as LocalFile)

  return { tree: buildTree(items, links) }
}

export async function workRefresh($: EngineInterface) {
  if (board && (await refreshJson($, board.state, board.path))) $.ui.invalidate('ui.render')
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

type Ctx = { els: Els; now: number }

export function workView($: EngineInterface, w: WorkBoard): View {
  const treeNow = () => workTree(w.state.value).tree

  return {
    id: w.spec.id,
    title: w.spec.title ?? w.spec.id,
    scope: 'shared',
    guide: { tool: WORK_TOOL, text: `keep its ${w.spec.id} view current with ${WORK_TOOL}` },
    onShow: () => workRefresh($),
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
      const ctx: Ctx = { els, now }
      const at = Date.parse((w.state.value as LocalFile).updated_at ?? '')
      const fresh = readError ?? (Number.isNaN(at) ? '' : `Updated ${ago(now - at)}`)
      const notes = [...w.warnings, ...tree.warnings]

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
    if (node.children.length > 0) out.push(...level(ctx, item.id, node.children))

    return out
  }

  function row(ctx: Ctx, node: Node, isOpen: boolean) {
    const { Box, Text, Button } = ctx.els
    const { item } = node
    const tag = TAGS[node.shown]
    const quiet = node.shown === 'done' || undefined
    const hasMore = node.children.length > 0 || Boolean(item.detail) || item.links.length > 0 || Boolean(item.workspace)
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
        <Text dimColor={quiet} wrap="truncate-end">
          {item.title}
        </Text>
      </Box>
    )
  }

  /** What a pressed-open Item shows above its children: its detail, links, and workspace. */
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
    const { workspace } = item
    if (workspace) {
      buttons.push(
        <Button
          key={`wspace-${item.id}`}
          label="workspace"
          plain
          dimColor
          onPress={async () => {
            w.notice = await focusWorkspace($, workspace)
            $.ui.invalidate('ui.render')
          }}
        />,
      )
    }
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
