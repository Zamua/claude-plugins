import type { EngineInterface, RenderNode } from 'claude-code'

import { ago, dueOf, fitLine, fixed, openUrl, sourceLabel, span, spans, stamp } from '../kit'
import type { Els, Part, View } from '../kit'
import { paneWidth } from '../pane'
import { currentWork, isRootHere, workNow } from './board'
import type { Node, Session, Tree } from './model'
import { focusSession } from './sessions'
import type { LocalFile } from './sources/file'

const DAY_MS = 24 * 3600e3
// An answered ask stays behind the fold this long, so the person can see what they decided lately
const ANSWERED_MS = 7 * DAY_MS
// A line's right side is fixed columns: the session that asked, when it is due, and how long it has waited
const WHO_WIDTH = 14
const DUE_WIDTH = 'Mon 11-02'.length
const AGE_WIDTH = 3
const COLUMNS_WIDTH = 1 + WHO_WIDTH + 2 + DUE_WIDTH + 2 + AGE_WIDTH

const opened = new Set<string>()
let isAnsweredShown = false
let notice: string | undefined

const cut = (text: string, width: number) => ([...text].length <= width ? text : `${[...text].slice(0, width - 1).join('')}…`)
const widthOf = (parts: Part[]) => parts.reduce((n, part, at) => n + [...part.text].length + (at > 0 ? 1 : 0), 0)

/** The session nearest an ask: one under its Item, else under the closest Item above it, active last first. */
function askerOf(node: Node): Session | undefined {
  for (let at: Node | undefined = node; at; at = at.parent) {
    const latest = [...at.sessions].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]
    if (latest) return latest
  }

  return undefined
}

const dueAt = (node: Node) => Date.parse(node.item.target ?? node.eta ?? '')

/**
 * Every Item whose own status is needs, whatever its Source: what blocks a session waiting on the person first, then
 * the nearest due, then the one waiting longest.
 */
function asksOf(tree: Tree): Node[] {
  const isBlocking = (node: Node) => askerOf(node)?.state === 'waiting'
  const due = (node: Node) => (Number.isNaN(dueAt(node)) ? Infinity : dueAt(node))
  const since = (node: Node) => Date.parse(node.item.started ?? '') || Infinity

  return [...tree.byId.values()]
    .filter(node => node.item.status === 'needs')
    .sort((a, b) => Number(isBlocking(b)) - Number(isBlocking(a)) || due(a) - due(b) || since(a) - since(b))
}

/** The asks answered lately, newest first. */
function answeredOf(tree: Tree, now: number): Node[] {
  const finished = (node: Node) => Date.parse(node.item.finished ?? '')

  return [...tree.byId.values()]
    .filter(node => node.item.answer && node.item.status === 'done' && now - finished(node) < ANSWERED_MS)
    .sort((a, b) => finished(b) - finished(a))
}

async function rootTree($: EngineInterface, isDrawing = false): Promise<Tree | undefined> {
  const tree = await workNow($, isDrawing)

  return tree && (await isRootHere($, tree)) ? tree : undefined
}

export function decisionsView($: EngineInterface): View {
  return {
    id: 'decisions',
    title: 'decisions',
    scope: 'shared',
    isAvailable: async () => {
      const tree = await rootTree($)

      return tree !== undefined && asksOf(tree).length + answeredOf(tree, await $.clock.now()).length > 0
    },
    needs: async () => {
      const tree = await rootTree($)

      return tree ? asksOf(tree).length : 0
    },
    render: async els => {
      const { Box, Button, Text } = els
      const now = await $.clock.now()
      const tree = await rootTree($, true)
      if (!tree) {
        return (
          <Text dimColor wrap="wrap">
            The root session lists every ask for the person here.
          </Text>
        )
      }
      const asks = asksOf(tree)
      const answered = answeredOf(tree, now)
      const at = Date.parse((currentWork()?.state.value as LocalFile | undefined)?.updated_at ?? '')
      const columns = paneWidth() - 2

      return (
        <Box key="decisions" flexDirection="column" paddingRight={1}>
          {!Number.isNaN(at) && stamp(els, `Updated ${ago(now - at)}`)}
          {asks.length === 0 && <Text dimColor>Nothing waits on you.</Text>}
          {asks.flatMap(node => lines(els, node, now, columns))}
          {answered.length > 0 && (
            <Box key="danswered" flexDirection="column" marginTop={asks.length > 0 ? 1 : 0}>
              <Button
                key="dansweredtoggle"
                label={`${isAnsweredShown ? '▾' : '▸'} ✓ ${answered.length} answered`}
                plain
                dimColor
                onPress={() => {
                  isAnsweredShown = !isAnsweredShown
                  $.ui.invalidate('ui.render')
                }}
              />
              {isAnsweredShown && answered.flatMap(node => lines(els, node, now, columns))}
            </Box>
          )}
          {notice && (
            <Text key="dnotice" color="yellow" wrap="wrap">
              {notice}
            </Text>
          )}
        </Box>
      )
    },
  }

  /**
   * One line per ask, pressed to open it: its title cut to the room left, then fixed columns at the right edge, every
   * cell written as spaces where empty: the session that asked, when it is due, and how long it has waited. Opened, it
   * shows its detail, where the options and the recommendation live, its answer once given, its links, and a way to
   * the session that asked.
   */
  function lines(els: Els, node: Node, now: number, columns: number): RenderNode[] {
    const { Box, Button, Markdown, Text } = els
    const { item } = node
    const isOpen = opened.has(item.id)
    const isDone = item.status === 'done'
    const asker = askerOf(node)
    const room = columns - COLUMNS_WIDTH
    const line = fitLine([{ text: isOpen ? '▾' : '▸', dimColor: true }], { text: item.title, dimColor: isDone }, room)
    const pad = Math.max(0, room - widthOf(line))
    const who = cut(asker?.label ?? item.origin?.by ?? '', WHO_WIDTH)
    const due = isDone ? undefined : dueOf(item.target, undefined, now)
    const started = Date.parse(item.started ?? '')
    const age = isDone || Number.isNaN(started) ? '' : span(now - started)
    const out: RenderNode[] = [
      <Box key={`drow-${item.id}`} flexDirection="row">
        <Button
          key={`dtoggle-${item.id}`}
          plain
          onPress={() => {
            if (opened.has(item.id)) opened.delete(item.id)
            else opened.add(item.id)
            $.ui.invalidate('ui.render')
          }}
        >
          {spans(els, line)}
        </Button>
        {pad > 0 && fixed(els, `dpad-${item.id}`, <Text>{' '.repeat(pad)}</Text>)}
        <Box key={`dfact-${item.id}`} flexDirection="row" flexShrink={0}>
          <Text dimColor>{` ${who.padEnd(WHO_WIDTH)}  `}</Text>
          <Text color={due?.color} dimColor={!due?.color || undefined}>
            {(due?.text ?? '').padEnd(DUE_WIDTH)}
          </Text>
          <Text dimColor>{`  ${age.padStart(AGE_WIDTH)}`}</Text>
        </Box>
      </Box>,
    ]
    if (!isOpen) return out
    out.push(
      <Box key={`dmore-${item.id}`} flexDirection="column" marginLeft={2} marginBottom={1}>
        {item.answer && <Text color="success" wrap="wrap">{`Answer: ${item.answer}`}</Text>}
        {item.detail && <Markdown key={`ddetail-${item.id}`} text={item.detail} />}
        {item.links.map((link, i) => (
          <Button
            key={`dlink-${item.id}-${i}`}
            plain
            onPress={async () => {
              notice = await openUrl($, link.url)
              $.ui.invalidate('ui.render')
            }}
          >
            <Text color="suggestion">{`↗ ${link.label || sourceLabel(link.url, currentWork()?.labels)}`}</Text>
          </Button>
        ))}
        {asker && (
          <Button
            key={`dfocus-${item.id}`}
            plain
            onPress={async () => {
              notice = await focusSession($, asker)
              $.ui.invalidate('ui.render')
            }}
          >
            <Text color="claude">→</Text>
            <Text dimColor>{` ${asker.label}`}</Text>
          </Button>
        )}
      </Box>,
    )

    return out
  }
}
