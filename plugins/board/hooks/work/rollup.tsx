import type { Color, EngineInterface, RenderNode } from 'claude-code'

import type { PrFacts, TrackedPr } from '../../types'
import { fitLine, fixed, span, spans } from '../kit'
import type { Els, Part, View } from '../kit'
import { paneWidth } from '../pane'
import { storedValues } from '../store'
import { cachedFacts } from '../github/cache'
import { factsFor, needsYou, prTable } from '../views/prs'
import { readReviews } from '../views/review'
import { REVIEW_STATES } from '../views/review-board'
import type { ReviewDigest, ReviewState } from '../views/review-board'
import type { Artifact, Node, Session, Tree } from './model'
import { focusSession } from './sessions'
import { artifactIdOf, trackedPrs } from './sources/github'
import { isRootHere, workNow } from './board'

const POLL_MS = 60_000
// GitHub is asked only while someone looks at a rollup
const SHOWN_MS = 2 * 60_000

// A review's state as the prs rows mark a pull request's, where a mark says it better than its counts
const REVIEW_MARKS: Partial<Record<ReviewState, { glyph: string; color: Color }>> = {
  approved: { glyph: '✓', color: 'success' },
  finished: { glyph: '◆', color: 'merged' },
}
// A review line's right side is fixed columns: what waits, its open pull requests, its age and its session
const STATUS_WIDTH = '99 threads'.length
const PRS_WIDTH = '99 PRs'.length
const AGE_WIDTH = 3
const COLUMNS_WIDTH = 1 + STATUS_WIDTH + 2 + PRS_WIDTH + 2 + AGE_WIDTH + 2
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** What a review waits on: comments for the person to pick, else threads on its authors, else nothing while it is under way. */
function statusOf(r: ReviewDigest): Part {
  if (r.toPick > 0) return { text: `${r.toPick} to pick`, color: 'warning' }
  if (r.unanswered > 0) return { text: counted(r.unanswered, 'thread'), dimColor: true }

  return { text: r.state === 'reviewing' ? 'reviewing' : '', dimColor: true }
}

/** One tab: a section of the work view, each top-level Item in it that holds rows a part under its title. */
type Tab<T> = { title: string; parts: { key: string; heading: string; rows: T[] }[] }

const topOf = (node: Node): Node => (node.parent ? topOf(node.parent) : node)
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-')

/** The rows each top-level Item holds, in the work view's sections and order, then the ones under none as Unplaced. */
function tabsOf<T>(tree: Tree, byTop: Map<Node, T[]>, loose: T[]): Tab<T>[] {
  const sections = tree.sections ?? [
    { title: 'Outcomes', nodes: tree.outcomes },
    { title: 'Responsibilities', nodes: tree.responsibilities },
  ]
  const tabs = [...sections, { title: 'Inbox', nodes: tree.inbox }].map(section => ({
    title: section.title,
    parts: section.nodes.flatMap(node => {
      const rows = byTop.get(node) ?? []

      return rows.length > 0 ? [{ key: node.item.id, heading: node.item.title, rows }] : []
    }),
  }))
  if (loose.length > 0) tabs.push({ title: 'Unplaced', parts: [{ key: 'unplaced', heading: '', rows: loose }] })

  return tabs.filter(tab => tab.parts.length > 0)
}

const chosenOf = <T,>(tabs: Tab<T>[], chosen: string, needs: (tab: Tab<T>) => number) =>
  tabs.find(tab => tab.title === chosen) ?? tabs.find(tab => needs(tab) > 0) ?? tabs[0]

type Fresh = { text: string; isError: boolean }

/** A button per tab with what in it waits on the person, pressed to show that tab, and how fresh the view is at the right. */
function tabBar<T>(
  els: Els,
  prefix: string,
  tabs: Tab<T>[],
  shown: Tab<T>,
  needs: (tab: Tab<T>) => number,
  choose: (title: string) => void,
  fresh: Fresh,
) {
  const { Box, Button, Text } = els

  return (
    <Box key={`${prefix}tabs`} flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1} marginBottom={1}>
      {tabs.flatMap((tab, at) => {
        const isShown = tab === shown
        const count = needs(tab)

        return [
          ...(at > 0 ? [<Text dimColor>·</Text>] : []),
          <Button key={`${prefix}tab-${slug(tab.title)}`} plain onPress={() => choose(tab.title)}>
            <Text bold={isShown || undefined} color={isShown ? 'claude' : undefined} dimColor={!isShown || undefined}>
              {tab.title}
            </Text>
            {count > 0 && (
              <Text color="warning" bold>
                {` ${count}`}
              </Text>
            )}
          </Button>,
        ]
      })}
      <Box key={`${prefix}stamp`} flexGrow={1} justifyContent="flex-end">
        <Text color={fresh.isError ? 'error' : undefined} dimColor={!fresh.isError || undefined}>
          {fresh.text}
        </Text>
      </Box>
    </Box>
  )
}

// What the rollups last read, kept only for this module's life
let prs = new Map<string, TrackedPr>()
let viewer = ''
let checkedAt = 0
let githubError = ''
let reviews: ReviewDigest[] = []
let polledAt = NaN
let reviewError = ''
let reviewFacts = new Map<string, PrFacts>()
let shownAt = 0
let loadedAt = 0
let prTab = ''
let reviewTab = ''
const doneShown = new Set<string>()
const opened = new Set<string>()

const isOpen = (p: TrackedPr) => !p.facts || p.facts.state === 'OPEN'
const artifactsUnder = (node: Node): Artifact[] => [...node.artifacts, ...node.children.flatMap(artifactsUnder)]

/** Every pull request the tree places, by the top-level Item it sits under, and the open ones it places nowhere. */
function prRows(tree: Tree): { byTop: Map<Node, TrackedPr[]>; loose: TrackedPr[] } {
  const known = (ids: Artifact[]) => ids.flatMap(a => prs.get(a.id) ?? [])
  const tops = [...tree.outcomes, ...tree.responsibilities, ...tree.inbox]

  return {
    byTop: new Map(tops.map(top => [top, known(artifactsUnder(top))])),
    loose: known(tree.unplaced.artifacts),
  }
}

/**
 * The pull requests every session tracks, with what any session cached of GitHub, and, when `mayAsk`, asking GitHub
 * through the prs view's cache and queue for the open ones the tree shows.
 */
async function refreshPrs($: EngineInterface, tree: Tree, mayAsk: boolean) {
  const got = await trackedPrs($, await storedValues($, 'board'))
  viewer = got.viewer
  const all = new Map(got.tracked.map(({ pr }) => [artifactIdOf(pr), pr]))
  if (mayAsk) {
    const shown = new Set([...tree.byId.values()].flatMap(node => node.artifacts.map(a => a.id)))
    for (const a of tree.unplaced.artifacts) shown.add(a.id)
    const ask = [...all].filter(([id, p]) => shown.has(id) && isOpen(p)).map(([, p]) => p)
    if (ask.length > 0) {
      const fresh = await factsFor($, ask, viewer)
      for (const [id, p] of all) {
        const facts = fresh.facts.get(p.key)
        if (facts) all.set(id, { ...p, facts })
      }
      viewer = fresh.viewer || viewer
      checkedAt = fresh.checkedAt
      githubError = fresh.error
    }
  }
  prs = all
}

/** Every review, and for each one pressed open, its pull requests' facts from the shared cache, asked of GitHub when `mayAsk`. */
async function refreshReviews($: EngineInterface, mayAsk: boolean) {
  const got = await readReviews($)
  reviews = got.reviews
  polledAt = got.polledAt
  reviewError = got.error ?? ''
  const listed = reviews.filter(r => opened.has(r.key)).flatMap(r => r.prs.map(asTracked))
  const cached = await cachedFacts($)
  const facts = new Map(cached.facts)
  if (mayAsk && listed.length > 0) {
    const fresh = await factsFor($, listed, cached.viewer)
    for (const [key, one] of fresh.facts) facts.set(key, one)
  }
  reviewFacts = facts
}

function asTracked(p: ReviewDigest['prs'][number]): TrackedPr {
  const [path = '', number = ''] = p.pr.split('#')
  const [owner = '', repo = ''] = path.split('/')
  const key = p.pr.toLowerCase()
  const facts = reviewFacts.get(key)

  return { key, owner, repo, number: p.number || Number(number), url: p.url, note: '', stack: '', ...(facts && { facts }) }
}

async function refreshAll($: EngineInterface, force = false) {
  const tree = await workNow($)
  if (!tree || !(await isRootHere($, tree))) return
  const now = await $.clock.now()
  const mayAsk = force || now - shownAt < SHOWN_MS
  loadedAt = now
  await refreshPrs($, tree, mayAsk)
  await refreshReviews($, mayAsk)
  $.ui.invalidate('ui.render')
}

/** The root's tree, read once before the first timer tick so the rollups' tabs show from the first draw. */
async function rootTree($: EngineInterface): Promise<Tree | undefined> {
  const tree = await workNow($)
  if (!tree || !(await isRootHere($, tree))) return undefined
  if (loadedAt === 0) await refreshAll($)

  return tree
}

export function rollupStart($: EngineInterface) {
  $.clock.every(POLL_MS, () => refreshAll($))
}

const tabNeeds = (tab: Tab<TrackedPr>) => tab.parts.reduce((n, part) => n + part.rows.filter(p => needsYou(p, viewer)).length, 0)

export function rollupPrsView($: EngineInterface): View {
  const tabsNow = async () => {
    const tree = await rootTree($)
    if (!tree) return []
    const { byTop, loose } = prRows(tree)

    return tabsOf(tree, byTop, loose)
  }

  return {
    id: 'allprs',
    title: 'all prs',
    scope: 'shared',
    onShow: () => refreshAll($, true),
    isAvailable: async () => (await tabsNow()).length > 0,
    needs: async () => (await tabsNow()).reduce((n, tab) => n + tabNeeds(tab), 0),
    render: async els => {
      const { Box, Button, Text } = els
      const now = await $.clock.now()
      shownAt = now
      await workNow($, true)
      const tabs = await tabsNow()
      const shown = chosenOf(tabs, prTab, tabNeeds)
      if (!shown) {
        return (
          <Text dimColor wrap="wrap">
            No pull requests in the tree yet. The ones any session tracks show here, in the work view's sections.
          </Text>
        )
      }
      const fresh = {
        text: githubError ? `GitHub check failed: ${githubError}` : checkedAt > 0 ? `checked ${span(now - checkedAt)} ago` : '',
        isError: Boolean(githubError),
      }
      // What needs the person leads each part, then the open ones; the merged and closed fold behind a count
      const sorted = shown.parts.map(part => ({
        ...part,
        open: part.rows.filter(isOpen).sort((a, b) => Number(needsYou(b, viewer)) - Number(needsYou(a, viewer))),
        done: part.rows.filter(p => !isOpen(p)),
      }))
      const done = sorted.reduce((n, part) => n + part.done.length, 0)
      const isDoneShown = doneShown.has(shown.title)
      const groups = sorted.flatMap(part => {
        const rows = isDoneShown ? [...part.open, ...part.done] : part.open
        if (rows.length === 0) return []

        return [
          {
            key: `rgroup-${part.key}`,
            ...(part.heading && { heading: (
              <Text bold wrap="truncate-end">
                {part.heading}
              </Text>
            ) }),
            prs: rows,
            chains: rows.map(p => [p]),
          },
        ]
      })

      return (
        <Box key="rollup-prs" flexDirection="column">
          {tabBar(
            els,
            'rp',
            tabs,
            shown,
            tabNeeds,
            title => {
              prTab = title
              $.ui.invalidate('ui.render')
            },
            fresh,
          )}
          {groups.length > 0 && (
            <Box key="rprs" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
              {prTable(els, groups, viewer, undefined, true)}
            </Box>
          )}
          {done > 0 && (
            <Box key="rdonebox" paddingX={1}>
              <Button
                key="rdone"
                label={`${isDoneShown ? '▾' : '▸'} ✓ ${done} merged or closed`}
                plain
                dimColor
                onPress={() => {
                  if (isDoneShown) doneShown.delete(shown.title)
                  else doneShown.add(shown.title)
                  $.ui.invalidate('ui.render')
                }}
              />
            </Box>
          )}
        </Box>
      )
    },
  }
}

const rankOf = (r: ReviewDigest) => REVIEW_STATES.indexOf(r.state)
const reviewTabNeeds = (tab: Tab<ReviewDigest>) => tab.parts.reduce((n, part) => n + part.rows.filter(r => r.state === 'pick').length, 0)

/**
 * Each review under the top-level Item its session sits under, or failing that, the one the first of its pull requests
 * the tree places sits under.
 */
function reviewRows(tree: Tree): { byTop: Map<Node, ReviewDigest[]>; loose: ReviewDigest[] } {
  const prTop = new Map<string, Node>()
  for (const node of tree.byId.values()) for (const a of node.artifacts) prTop.set(a.id.toLowerCase(), topOf(node))
  const byTop = new Map<Node, ReviewDigest[]>()
  const loose: ReviewDigest[] = []
  for (const r of reviews) {
    const session = sessionOf(tree, r)
    const item = session ? tree.sessionItem.get(session.id) : undefined
    const node = item ? tree.byId.get(item) : undefined
    const top = node ? topOf(node) : r.prs.map(p => prTop.get(`pr:${p.pr}`.toLowerCase())).find(Boolean)
    if (top) byTop.set(top, [...(byTop.get(top) ?? []), r])
    else loose.push(r)
  }

  return { byTop, loose }
}

const sessionOf = (tree: Tree, r: ReviewDigest): Session | undefined =>
  r.agent ? [...tree.sessions.values()].find(one => one.harnessId === r.agent) : undefined

export function rollupReviewsView($: EngineInterface): View {
  const tabsNow = async () => {
    const tree = await rootTree($)
    if (!tree) return { tabs: [] }
    const { byTop, loose } = reviewRows(tree)

    return { tree, tabs: tabsOf(tree, byTop, loose) }
  }

  return {
    id: 'allreviews',
    title: 'all reviews',
    scope: 'shared',
    onShow: () => refreshAll($, true),
    isAvailable: async () => (await tabsNow()).tabs.length > 0,
    needs: async () => (await tabsNow()).tabs.reduce((n, tab) => n + reviewTabNeeds(tab), 0),
    render: async els => {
      const { Box, Text } = els
      const now = await $.clock.now()
      shownAt = now
      await workNow($, true)
      const { tree, tabs } = await tabsNow()
      const shown = chosenOf(tabs, reviewTab, reviewTabNeeds)
      if (!tree || !shown) {
        return (
          <Text dimColor wrap="wrap">
            {reviewError || 'No reviews running. Every pr-review-board review shows here, in the work view\'s sections.'}
          </Text>
        )
      }
      const fresh = { text: reviewError || (Number.isNaN(polledAt) ? '' : `polled ${span(now - polledAt)} ago`), isError: Boolean(reviewError) }
      const columns = paneWidth() - 2

      return (
        <Box key="rollup-reviews" flexDirection="column" paddingRight={1}>
          {tabBar(
            els,
            'rr',
            tabs,
            shown,
            reviewTabNeeds,
            title => {
              reviewTab = title
              $.ui.invalidate('ui.render')
            },
            fresh,
          )}
          {shown.parts.map((part, at) => (
            <Box key={`rrpart-${part.key}`} flexDirection="column" marginTop={at > 0 ? 1 : 0}>
              {part.heading && (
                <Text bold wrap="truncate-end">
                  {part.heading}
                </Text>
              )}
              {[...part.rows]
                .sort((a, b) => rankOf(a) - rankOf(b) || (b.updatedAt || 0) - (a.updatedAt || 0))
                .flatMap(r => reviewLines(els, tree, r, now, columns))}
            </Box>
          ))}
        </Box>
      )
    },
  }

  /**
   * One line per review, pressed to open its open pull requests: a mark once approved or merged and its title cut to
   * the room left, then fixed columns at the right edge, every cell written as spaces where empty: what it waits on,
   * its open pull requests, how long since it last changed, and a dot that brings its session to the front.
   */
  function reviewLines(els: Els, tree: Tree, r: ReviewDigest, now: number, columns: number): RenderNode[] {
    const { Box, Button, Text } = els
    const isShown = opened.has(r.key)
    const session = sessionOf(tree, r)
    const mark = REVIEW_MARKS[r.state]
    const parts: Part[] = [
      { text: isShown ? '▾' : '▸', dimColor: true },
      mark ? { text: mark.glyph, color: mark.color } : { text: ' ' },
    ]
    const room = columns - COLUMNS_WIDTH
    const line = fitLine(parts, { text: r.title, dimColor: r.state === 'finished' }, room)
    const pad = Math.max(0, room - line.reduce((n, part, at) => n + [...part.text].length + (at > 0 ? 1 : 0), 0))
    const status = statusOf(r)
    const prs = r.openPrs > 0 ? counted(r.openPrs, 'PR') : ''
    const age = Number.isNaN(r.updatedAt) ? '' : span(now - r.updatedAt)
    const out: RenderNode[] = [
      <Box key={`rrrow-${r.key}`} flexDirection="row">
        <Button
          key={`rrtoggle-${r.key}`}
          plain
          onPress={async () => {
            if (opened.has(r.key)) opened.delete(r.key)
            else opened.add(r.key)
            await refreshReviews($, true)
            $.ui.invalidate('ui.render')
          }}
        >
          {spans(els, line)}
        </Button>
        {pad > 0 && fixed(els, `rrpad-${r.key}`, <Text>{' '.repeat(pad)}</Text>)}
        <Box key={`rrfact-${r.key}`} flexDirection="row" flexShrink={0}>
          <Text color={status.color} dimColor={status.dimColor || undefined}>{` ${status.text.padStart(STATUS_WIDTH)}`}</Text>
          <Text dimColor>{`  ${prs.padStart(PRS_WIDTH)}  ${age.padStart(AGE_WIDTH)} `}</Text>
        </Box>
        {session ? (
          fixed(
            els,
            `rrmarkbox-${r.key}`,
            <Button key={`rrmark-${r.key}`} plain onPress={() => focusSession($, session)}>
              <Text color={session.state === 'waiting' ? 'warning' : session.state === 'working' ? 'success' : 'inactive'}>●</Text>
            </Button>,
          )
        ) : (
          fixed(els, `rrnomark-${r.key}`, <Text> </Text>)
        )}
      </Box>,
    ]
    if (!isShown) return out
    const listed = r.prs.map(asTracked)
    const open = listed.filter((p, i) => (p.facts?.state ?? r.prs[i]?.state ?? 'OPEN') === 'OPEN')
    const titles = new Map(r.prs.flatMap(p => (p.title ? [[p.pr.toLowerCase(), p.title] as const] : [])))
    out.push(
      <Box key={`rrprs-${r.key}`} flexDirection="column" marginLeft={2}>
        {prTable(els, [{ key: `rrgroup-${r.key}`, prs: open, chains: open.map(p => [p]) }], viewer, p => titles.get(p.key), true)}
      </Box>,
    )

    return out
  }
}
