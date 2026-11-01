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
// A line's right side is fixed columns: the session that asked, as wide as the longest label shown, when it is due,
// and how long it has waited
const MAX_WHO = 10
const DUE_WIDTH = 'Mon 11-02'.length
const AGE_WIDTH = 3

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

const whoOf = (node: Node) => askerOf(node)?.label ?? node.item.origin?.by ?? ''

const dueAt = (node: Node) => Date.parse(node.item.target ?? node.eta ?? '')
const topOf = (node: Node): Node => (node.parent ? topOf(node.parent) : node)

/** An ask's parent Item and the asks it holds: a plain Item heads a group, an ask leads its own. */
type Group = { key: string; head?: Node; asks: Node[] }
/** The groups under one top-level Item; `top` is absent for asks that are top-level themselves. */
type Section = { top?: Node; groups: Group[] }

/**
 * The asks, ranked, as the person reads them: under a heading per top-level Item, then grouped by their parent Item.
 * An ask under another ask sits beneath the outermost one, so linking asks under one Item or ask groups them. A group
 * and a part rank by their most urgent ask.
 */
function partsOf(asks: Node[]): { parts: Section[]; under: Map<Node, Node[]> } {
  const index = new Map(asks.map((node, at) => [node, at]))
  const under = new Map<Node, Node[]>()
  const free: Node[] = []
  for (const ask of asks) {
    let outer: Node | undefined
    for (let at = ask.parent; at; at = at.parent) if (index.has(at)) outer = at
    if (outer) under.set(outer, [...(under.get(outer) ?? []), ask])
    else free.push(ask)
  }
  const rankOf = (ask: Node) => Math.min(index.get(ask) ?? Infinity, ...(under.get(ask) ?? []).map(one => index.get(one) ?? Infinity))
  const parts = new Map<Node | undefined, Map<string, Group>>()
  for (const ask of [...free].sort((a, b) => rankOf(a) - rankOf(b))) {
    const top = ask.parent ? topOf(ask) : undefined
    const head = ask.parent && ask.parent !== top ? ask.parent : undefined
    const groups = parts.get(top) ?? new Map<string, Group>()
    parts.set(top, groups)
    const key = head?.item.id ?? ''
    groups.set(key, { key, ...(head && { head }), asks: [...(groups.get(key)?.asks ?? []), ask] })
  }

  return { parts: [...parts].map(([top, groups]) => ({ ...(top && { top }), groups: [...groups.values()] })), under }
}

/** The earliest due of these asks, as an ISO time. */
function earliestOf(asks: Node[]): string | undefined {
  const at = Math.min(...asks.map(dueAt).filter(one => !Number.isNaN(one)))

  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

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
      const shown = isAnsweredShown ? [...asks, ...answered] : asks
      const whoWidth = Math.min(MAX_WHO, Math.max(0, ...shown.map(node => [...whoOf(node)].length)))
      const { parts, under } = partsOf(asks)
      const withUnder = (ask: Node) => [ask, ...(under.get(ask) ?? [])]
      const askLines = (ask: Node, depth: number) => [
        ...lines(els, ask, now, columns, whoWidth, depth, earliestOf(withUnder(ask))),
        ...(under.get(ask) ?? []).flatMap(one => lines(els, one, now, columns, whoWidth, depth + 1, one.item.target)),
      ]
      const groupLines = (group: Group) =>
        group.head
          ? [
              headLine(els, group.head, now, columns, whoWidth, earliestOf(group.asks.flatMap(withUnder)), group.asks.flatMap(withUnder).length > 1),
              ...group.asks.flatMap(ask => askLines(ask, 1)),
            ]
          : group.asks.flatMap(ask => askLines(ask, 0))

      return (
        <Box key="decisions" flexDirection="column" paddingRight={1}>
          {!Number.isNaN(at) && stamp(els, `Updated ${ago(now - at)}`)}
          {asks.length === 0 && <Text dimColor>Nothing waits on you.</Text>}
          {parts.map((part, at) => (
            <Box key={`dpart-${part.top?.item.id ?? 'top'}`} flexDirection="column" marginTop={at > 0 ? 1 : 0}>
              {part.top && (
                <Text bold wrap="truncate-end">
                  {part.top.item.title}
                </Text>
              )}
              {part.groups.flatMap(groupLines)}
            </Box>
          ))}
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
              {isAnsweredShown && answered.flatMap(node => lines(els, node, now, columns, whoWidth, 0, undefined))}
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

  /** The fixed columns at a line's right edge, every cell written as spaces where empty. */
  function facts(els: Els, key: string, who: string, whoWidth: number, due: string | undefined, now: number, age: string) {
    const { Box, Text } = els
    const when = dueOf(due, undefined, now)

    return (
      <Box key={key} flexDirection="row" flexShrink={0}>
        <Text dimColor>{` ${who.padEnd(whoWidth)}  `}</Text>
        <Text color={when?.color} dimColor={!when?.color || undefined}>
          {(when?.text ?? '').padEnd(DUE_WIDTH)}
        </Text>
        <Text dimColor>{`  ${age.padStart(AGE_WIDTH)}`}</Text>
      </Box>
    )
  }

  /** A group's head: the plain Item its asks sit under, dim, with the earliest due among them when it holds several. */
  function headLine(els: Els, head: Node, now: number, columns: number, whoWidth: number, due: string | undefined, isSeveral: boolean) {
    const { Box, Text } = els
    const room = columns - (1 + whoWidth + 2 + DUE_WIDTH + 2 + AGE_WIDTH)
    const title = cut(head.item.title, room)

    return (
      <Box key={`dgroup-${head.item.id}`} flexDirection="row">
        <Text dimColor>{title.padEnd(room)}</Text>
        {facts(els, `dgfact-${head.item.id}`, '', whoWidth, isSeveral ? due : undefined, now, '')}
      </Box>
    )
  }

  /**
   * One line per ask, pressed to open it: its title cut to the room left, then the session that asked, when it is due
   * (for an ask holding others, the earliest of them), and how long it has waited. Opened, it shows its detail, where
   * the options and the recommendation live, its answer once given, its links, and a way to the session that asked.
   */
  function lines(els: Els, node: Node, now: number, columns: number, whoWidth: number, depth: number, due: string | undefined): RenderNode[] {
    const { Box, Button, Markdown, Text } = els
    const { item } = node
    const isOpen = opened.has(item.id)
    const isDone = item.status === 'done'
    const asker = askerOf(node)
    const room = columns - depth * 2 - (1 + whoWidth + 2 + DUE_WIDTH + 2 + AGE_WIDTH)
    const line = fitLine([{ text: isOpen ? '▾' : '▸', dimColor: true }], { text: item.title, dimColor: isDone }, room)
    const pad = Math.max(0, room - widthOf(line))
    const who = cut(whoOf(node), whoWidth)
    const started = Date.parse(item.started ?? '')
    const age = isDone || Number.isNaN(started) ? '' : span(now - started)
    const out: RenderNode[] = [
      <Box key={`drow-${item.id}`} flexDirection="row" paddingLeft={depth * 2}>
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
        {facts(els, `dfact-${item.id}`, who, whoWidth, isDone ? undefined : due, now, age)}
      </Box>,
    ]
    if (!isOpen) return out
    out.push(
      <Box key={`dmore-${item.id}`} flexDirection="column" marginLeft={depth * 2 + 2} marginBottom={1}>
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
