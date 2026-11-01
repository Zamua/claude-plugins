import type { EngineInterface, On, RenderNode } from 'claude-code'

import { ago, fixed } from '../kit'
import type { Els, View } from '../kit'
import { PANE, paneFocused, paneWidth, selectView } from '../pane'
import {
  chosenPeriod,
  currentWork,
  markDrawn,
  periodsOf,
  placedBoards,
  placedNeedsNow,
  rootOf,
  selfOf,
  setPeriod,
  WORK_TOOL,
  workRefresh,
  workTree,
} from './board'
import type { WorkBoard } from './board'
import { level, ranked, unplaced } from './lines'
import type { Ctx } from './lines'
import { inPeriod, needsTotal, pathTo } from './model'
import type { Node, Period, Session, Tree } from './model'
import { focusSession, liveNow, refreshLive } from './sessions'
import type { LocalFile } from './sources/file'

// What the person pressed open, for the session `pressedFor` names
const opened = new Set<string>()
const doneShown = new Set<string>()
let pressedFor = ''
// The session whose own Item the view has opened down to, once
let placedFor = ''
let isPeriodOpen = false
let wasFocused = false

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

function forSession(sessionId: string) {
  if (pressedFor === sessionId) return
  opened.clear()
  doneShown.clear()
  pressedFor = sessionId
}

const openPath = (tree: Tree, id: string) => {
  for (const item of pathTo(tree, id)) opened.add(item.id)
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
  const w = currentWork()
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
  const w = currentWork()
  if (!w) return undefined
  markDrawn(await $.clock.now())
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
      markDrawn(now)
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
      const chosen = periods.find(one => one.name === chosenPeriod())
      // A click outside the pane takes the keyboard back from it, which folds the Period list too
      if (wasFocused && !paneFocused()) isPeriodOpen = false
      wasFocused = paneFocused()
      // The view keeps a cell clear of the pane's right edge, and one more spare so a row that fits exactly stops short
      const ctx: Ctx = {
        w,
        els,
        now,
        tree,
        columns: paneWidth() - 2,
        opened,
        doneShown,
        placed: placedBoards(),
        boardNeeds: placedNeedsNow(),
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
              {level($, ctx, 'top-inbox', inbox)}
            </Box>
          )}
          {top.length > 0 && !tree.sections && (
            <Box key="top" flexDirection="column">
              {level($, ctx, 'top', top)}
            </Box>
          )}
          {sections.map((section, at) => {
            const key = `sec-${section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

            return (
              <Box key={`w${key}`} flexDirection="column" marginTop={at > 0 ? 1 : 0}>
                <Text dimColor bold>
                  {section.title}
                </Text>
                {level($, ctx, key, section.nodes)}
              </Box>
            )
          })}
          {unplaced($, ctx, tree)}
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
          const isOn = one.name === chosenPeriod()

          return (
            <Button
              key={one.name ? `wper-${at}` : 'wper-all'}
              plain
              onPress={() => {
                setPeriod(one.name)
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
}
