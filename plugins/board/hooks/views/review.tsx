import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, RenderNode } from 'claude-code'

import type { TrackedPr } from '../../types'
import { ago, fixed, link, refreshJson, section, stamp } from '../kit'
import type { Els, JsonFile, SectionSpec, View } from '../kit'
import { factsFor, prTable } from './prs'
import type { GithubFacts } from './prs'

// The poller records every review here; the worker running one is the session it records
const STATE_PATH = '.config/pr-review-board/state.json'
const CONFIG_PATH = '.config/pr-review-board/config.json'
const POLL_MS = 10_000
const FACTS_MS = 60_000

const SEVERITIES: readonly SectionSpec[] = [
  { id: 'live', title: 'Live on merge', color: 'error' },
  { id: 'high', title: 'High', color: 'error' },
  { id: 'medium', title: 'Medium', color: 'warning' },
  { id: 'low-medium', title: 'Low to medium', color: 'suggestion' },
  { id: 'low', title: 'Low', color: 'permission' },
  { id: 'question', title: 'Questions', color: 'inactive' },
]
const STATUS_TAGS: Record<string, { text: string; color: Color }> = {
  approved: { text: 'approved', color: 'warning' },
  posted: { text: 'posted', color: 'success' },
}
// A posted comment waits on its author until the review marks it addressed
const FOLLOW_UPS: readonly (SectionSpec & { holds: (c: Comment) => boolean })[] = [
  { id: 'unaddressed', title: 'Unaddressed', color: 'warning', holds: c => !c.addressed },
  { id: 'addressed', title: 'Addressed', color: 'success', holds: c => c.addressed === true },
]
const RISK_COLORS: Record<string, Color> = { high: 'error', medium: 'warning', low: 'success' }
// Where a finding comes from, measured against the code path the change replaces
const ORIGIN_TAGS: Record<string, { text: string; color: Color }> = {
  new: { text: 'new', color: 'error' },
  carried: { text: 'carried over', color: 'inactive' },
  none: { text: 'not a bug', color: 'inactive' },
}

type Pr = { pr: string; number: number; url?: string; title?: string; other_open_threads?: number }
type CommentFile = { url?: string; label?: string; kind?: string }
type Comment = {
  n: number
  pr: string | number
  severity?: string
  confidence?: string
  status?: string
  origin?: string
  summary?: string
  body?: string
  detail?: string
  origin_note?: string
  status_note?: string
  target?: string
  location_url?: string
  files?: CommentFile[]
  posted_url?: string
  addressed?: boolean
  addressed_note?: string
}
type ReportSection = { id?: string; title?: string; markdown?: string }
type NamedStack = { id: string; title?: string; prs: string[]; verdict?: string; risk?: string; blast_radius?: string }
type Board = {
  updated_at?: string
  title?: string
  verdict?: string
  risk?: string
  blast_radius?: string
  prs?: Pr[]
  comments?: Comment[]
  report?: ReportSection[]
  stacks?: NamedStack[]
}
type Thread = { url: string; resolved?: boolean; replied?: boolean }
type Facts = { prs?: Record<string, { threads?: Thread[] }> }
type Review = { key: string; slug: string; prs: Pr[]; boardPath: string }
type Stack = Omit<NamedStack, 'prs'> & { title: string; prs: Pr[] }
type PollerState = { reviews?: Record<string, { status?: string; slug?: string; claude_session?: string; herdr_workspace?: string; prs?: string[] }> }

const stackChoice = atom({ plugin: 'board', key: 'reviewStack' } as const, '')

const commentsOf = (b: Board) => (Array.isArray(b.comments) ? b.comments : [])
const isPickable = (c: Comment) => !c.status || c.status === 'proposed' || c.status === 'approved'
const severityOf = (c: Comment) => SEVERITIES.find(s => s.id === c.severity) ?? (SEVERITIES[SEVERITIES.length - 1] as SectionSpec)

function prsFromState(prs: unknown): Pr[] {
  return (Array.isArray(prs) ? (prs as string[]) : []).map(pr => {
    const [repo, number] = pr.split('#')
    return { pr, number: Number(number), url: `https://github.com/${repo}/pull/${number}` }
  })
}

/** A comment names its pull request as `owner/repo#N`, or by bare number in a single-repo review. */
function prOf(c: Comment, prs: readonly Pr[]): { number: number; url?: string } {
  const found = prs.find(p => (typeof c.pr === 'string' ? p.pr === c.pr : p.number === c.pr))
  const number = found ? found.number : typeof c.pr === 'string' ? Number(c.pr.split('#')[1]) : c.pr

  return { number, ...(found?.url && { url: found.url }) }
}

/**
 * The board with the review threads the operator started that it did not post, from the poller's `github.json`,
 * counted while unresolved and unanswered.
 */
function withFacts(raw: Board, f: Facts | undefined): Board {
  if (!f || !f.prs || !Array.isArray(raw.prs)) return raw
  const facts = f.prs
  const posted = new Set(commentsOf(raw).map(c => c.posted_url).filter(Boolean))

  return {
    ...raw,
    prs: raw.prs.map(p => {
      const threads = Array.isArray(facts[p.pr]?.threads) ? (facts[p.pr]?.threads as Thread[]) : []

      return { ...p, other_open_threads: threads.filter(t => !posted.has(t.url) && !t.resolved && !t.replied).length }
    }),
  }
}

/**
 * The stacks the board names, each bottom layer first, then one stack per pull request the board puts in none. A board
 * that names no stacks is one stack holding every pull request.
 */
function stacksOf(b: Board, prs: Pr[]): Stack[] {
  const named = Array.isArray(b.stacks) ? b.stacks.filter(s => s && typeof s.id === 'string' && Array.isArray(s.prs)) : []
  if (named.length === 0) return [{ id: 'all', title: 'Stack', prs }]
  const byKey = new Map(prs.map(p => [p.pr, p]))
  const placed = new Set<string>()
  const stacks: Stack[] = named.map(s => {
    const members = s.prs.map(key => byKey.get(key)).filter((p): p is Pr => p !== undefined)
    for (const p of members) placed.add(p.pr)
    return { ...s, title: s.title || s.id, prs: members }
  })
  for (const p of prs) {
    if (!placed.has(p.pr)) stacks.push({ id: p.pr, title: `#${p.number}${p.title ? ` ${p.title}` : ''}`, prs: [p] })
  }

  return stacks
}

/** The id of the stack holding a comment's pull request; a comment on a pull request off the board belongs to none. */
function stackOf(c: Comment, prs: readonly Pr[], stacks: readonly Stack[]) {
  const found = prs.find(p => (typeof c.pr === 'string' ? p.pr === c.pr : p.number === c.pr))
  const stack = found && stacks.find(s => s.prs.includes(found))

  return stack ? stack.id : undefined
}

const otherOpen = (prs: readonly Pr[]) =>
  prs.reduce((sum, p) => sum + (Number.isInteger(p.other_open_threads) ? (p.other_open_threads as number) : 0), 0)

function labelled(els: Els, key: string, label: string, sentence: string) {
  const { Box, Text } = els

  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Text dimColor>{label.padEnd(5)}</Text>
      <Text wrap="wrap">{sentence}</Text>
    </Box>
  )
}

let home = ''
let sessionId = ''
let workspaceId: string | undefined
let review: Review | undefined
let board: Board | undefined
let readError: string | undefined
// Where this session's hand-written board goes, so the empty view can say where to write one
let manualPath = ''
const file: JsonFile<Board> = {}
const factsFile: JsonFile<Facts> = {}
let merged: { raw?: Board | undefined; facts?: Facts | undefined; value?: Board | undefined } = {}
let github: GithubFacts = { facts: new Map(), viewer: '', checkedAt: 0, error: '' }
let factsKeys = ''
let factsAt = 0
// Comment numbers ticked for the next post, and the comments and report sections shown in full; kept only for this module's life
const picks = new Set<number>()
const expanded = new Set<string>()
let notice: string | undefined

async function reviewsRoot($: EngineInterface) {
  try {
    const path = (await $.env.get('PR_REVIEW_BOARD_CONFIG')) || `${home}/${CONFIG_PATH}`
    if (await $.fs.exists(path)) {
      const root = (JSON.parse(await $.fs.read(path)) as { reviews_root?: string }).reviews_root
      if (root) return root.startsWith('~/') ? home + root.slice(1) : root
    }
  } catch {
    // An unreadable config falls back to the harness default
  }

  return `${home}/workspace/reviews`
}

/** A review the poller spawned: the one that recorded this session, else the one bound to this herdr workspace. */
async function spawnedReview($: EngineInterface, root: string): Promise<Review | undefined> {
  const path = (await $.env.get('PR_REVIEW_BOARD_STATE')) || `${home}/${STATE_PATH}`
  if (!(await $.fs.exists(path))) return undefined
  const state = JSON.parse(await $.fs.read(path)) as PollerState
  const active = Object.entries(state.reviews ?? {}).filter(([, r]) => r && r.status === 'ACTIVE')
  const match =
    active.find(([, r]) => r.claude_session && r.claude_session === sessionId) ??
    (workspaceId ? active.find(([, r]) => r.herdr_workspace === workspaceId) : undefined)
  if (!match) return undefined
  const [key, r] = match

  return { key, slug: r.slug || key, prs: prsFromState(r.prs), boardPath: `${root}/.pr-review-board/${key}/board.json` }
}

export async function reviewRefresh($: EngineInterface) {
  const before = [review?.key, board, readError]
  try {
    const root = await reviewsRoot($)
    manualPath = `${root}/.pr-review-board/manual-${sessionId}/board.json`
    const key = `manual-${sessionId}`
    review =
      (await spawnedReview($, root)) ??
      ((await $.fs.exists(manualPath)) ? { key, slug: key, prs: [], boardPath: manualPath } : undefined)
    if (review) {
      await refreshJson($, factsFile, review.boardPath.replace(/board\.json$/, 'github.json'))
      await refreshJson($, file, review.boardPath)
      // The same inputs give back the same board, so an unchanged poll redraws nothing
      if (file.value !== merged.raw || factsFile.value !== merged.facts) {
        merged = { raw: file.value, facts: factsFile.value, value: file.value && withFacts(file.value, factsFile.value) }
      }
      board = merged.value
      readError = file.error && `Could not read the review board: ${file.error}`
      // A comment that left `proposed` or `approved` cannot be posted again, so it stops counting as picked
      for (const c of board ? commentsOf(board) : []) if (!isPickable(c)) picks.delete(c.n)
    } else {
      board = undefined
      readError = undefined
    }
  } catch (err) {
    readError = `Could not read the review board: ${err instanceof Error ? err.message : String(err)}`
  }
  const after = [review?.key, board, readError]
  if (before.some((one, at) => one !== after[at])) $.ui.invalidate('ui.render')
  if (keysOf(reviewPrs()) !== factsKeys || (await $.clock.now()) - factsAt >= FACTS_MS) await reviewFacts($)
}

const reviewPrs = () => (board && Array.isArray(board.prs) ? board.prs : (review?.prs ?? []))
const keysOf = (prs: readonly Pr[]) => prs.map(p => p.pr).join(' ')

/** A pull request of the review as the prs board tracks one, with what GitHub last said of it. */
function trackedOf(p: Pr): TrackedPr {
  const [path = '', number = ''] = p.pr.split('#')
  const [owner = '', repo = ''] = path.split('/')
  const facts = github.facts.get(p.pr)

  return {
    key: p.pr,
    owner,
    repo,
    number: p.number || Number(number),
    url: p.url || `https://github.com/${path}/pull/${number}`,
    note: '',
    stack: '',
    ...(facts && { facts }),
  }
}

async function reviewFacts($: EngineInterface) {
  const prs = reviewPrs()
  factsKeys = keysOf(prs)
  factsAt = await $.clock.now()
  if (prs.length === 0) return
  github = await factsFor($, prs.map(trackedOf), github.viewer)
  $.ui.invalidate('ui.render')
}

function toggler($: EngineInterface, id: string) {
  return async () => {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    $.ui.invalidate('ui.render')
  }
}

/**
 * The view's head: the review's title, verdict, risk and blast radius in All, a stack's own in its view. Once
 * something was posted and nothing waits, neither a comment to decide nor a thread on the author, it says all
 * addressed.
 */
function header(els: Els, b: Board, r: Review, stack: Stack | undefined, comments: Comment[]) {
  const { Box, Text } = els
  const source = stack ?? b
  const title = stack ? stack.title : b.title || r.slug
  const posted = comments.filter(c => c.status === 'posted')
  const waiting =
    posted.some(c => !c.addressed) ||
    comments.some(isPickable) ||
    otherOpen(stack ? stack.prs : Array.isArray(b.prs) ? b.prs : []) > 0

  return (
    <Box key="summary" flexDirection="column" paddingX={1}>
      <Box key="title-row" flexDirection="row" columnGap={1}>
        <Text bold>{title}</Text>
        {source.verdict && <Text color={RISK_COLORS[source.verdict] ?? 'warning'}>{source.verdict}</Text>}
        {posted.length > 0 && !waiting && <Text color="success">all addressed</Text>}
      </Box>
      {source.risk && labelled(els, 'risk', 'Risk', source.risk)}
      {source.blast_radius && labelled(els, 'blast', 'Blast', source.blast_radius)}
    </Box>
  )
}

/** All, then one button per stack; pressing one narrows the view to that stack's pull requests and comments. */
function stackTabs($: EngineInterface, els: Els, stacks: readonly Stack[], chosen: Stack | undefined) {
  const { Box, Button, Text } = els
  const tabs = [{ id: '', title: 'All' }, ...stacks]

  return (
    <Box key="stack-tabs" flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1}>
      {tabs.flatMap((s, at) => {
        const isChosen = (chosen?.id ?? '') === s.id

        return [
          ...(at > 0 ? [<Text dimColor>·</Text>] : []),
          <Button key={`stack-tab-${s.id || 'all'}`} plain onPress={() => update($, stackChoice, () => s.id)}>
            <Text bold={isChosen || undefined} color={isChosen ? 'claude' : undefined} dimColor={!isChosen || undefined}>
              {s.title}
            </Text>
          </Button>,
        ]
      })}
    </Box>
  )
}

/** A stack's name and its verdict; in All the name is a button that narrows the view to the stack. */
function stackHeading($: EngineInterface, els: Els, key: string, stack: Stack, pressable: boolean) {
  const { Box, Text, Button } = els
  const name = <Text bold>{stack.title}</Text>

  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      {pressable ? (
        <Button key={`goto-${stack.id}`} plain onPress={() => update($, stackChoice, () => stack.id)}>
          {name}
        </Button>
      ) : (
        name
      )}
      {stack.verdict && <Text color={RISK_COLORS[stack.verdict] ?? 'warning'}>{stack.verdict}</Text>}
    </Box>
  )
}

/**
 * The pull requests in view, drawn as the prs board draws them: one stack under its own heading, or, in All, every
 * stack under its own. Each keeps the board's short title.
 */
function prList($: EngineInterface, els: Els, b: Board, stacks: readonly Stack[], several: boolean) {
  const { Box } = els
  const titles = new Map((Array.isArray(b.prs) ? b.prs : []).flatMap(p => (p.title ? [[p.pr, p.title] as const] : [])))
  const groups = stacks.map(s => ({
    key: several ? `group-${s.id}` : 'prs-group',
    heading: several ? stackHeading($, els, `stack-${s.id}`, s, true) : stackHeading($, els, 'prs-heading', s, false),
    prs: s.prs.map(trackedOf),
  }))

  return (
    <Box key="prs" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
      {prTable(els, groups, github.viewer, p => titles.get(p.key))}
    </Box>
  )
}

function fileLinksOf(els: Els, c: Comment) {
  const out: RenderNode[] = []
  const seen = new Set<string>()
  const add = (href: string | undefined, label: string, style: { color?: Color; bold?: boolean; dimColor?: boolean }) => {
    if (!href || seen.has(href)) return
    seen.add(href)
    out.push(link(els, href, label, style))
  }
  const files = Array.isArray(c.files) ? c.files : []
  add(c.location_url, c.target || 'code', { bold: true })
  for (const f of files) if (f && f.kind !== 'test') add(f.url, f.label || 'file', { dimColor: true })
  for (const f of files) if (f && f.kind === 'test') add(f.url, `test: ${f.label || 'scratch'}`, { color: 'suggestion' })
  add(c.posted_url, 'posted comment', { color: 'success' })

  return out
}

function commentRow($: EngineInterface, els: Els, c: Comment, prs: readonly Pr[]) {
  const { Box, Text, Button, Markdown } = els
  const picked = picks.has(c.n)
  const isOpen = expanded.has(`c${c.n}`)
  const toggle = async () => {
    if (picks.has(c.n)) picks.delete(c.n)
    else picks.add(c.n)
    $.ui.invalidate('ui.render')
  }
  const { number, url } = prOf(c, prs)
  const origin = c.origin ? ORIGIN_TAGS[c.origin] : undefined
  const tag = c.status ? STATUS_TAGS[c.status] : undefined
  const full: [string, string, string | undefined][] = [
    ['body', 'Posts as', c.body],
    ['detail', 'Finding', c.detail],
    ['origin', 'Origin', c.origin_note],
    ['status', 'Status', c.status_note],
  ]
  const shown = full.filter((one): one is [string, string, string] => Boolean(one[2]))
  const files = fileLinksOf(els, c)

  return (
    <Box key={`comment-${c.n}`} flexDirection="column">
      <Box key={`head-${c.n}`} flexDirection="row" columnGap={1}>
        {isPickable(c) ? (
          <Button key={`pick-${c.n}`} label={picked ? '[x]' : '[ ]'} plain dimColor={!picked} onPress={toggle} />
        ) : (
          <Text dimColor>{'   '}</Text>
        )}
        <Button key={`expand-${c.n}`} label={isOpen ? '▾' : '▸'} plain dimColor onPress={toggler($, `c${c.n}`)} />
        {fixed(els, `num-${c.n}`, <Text bold>{String(c.n).padStart(2)}</Text>)}
        {fixed(els, `prlink-${c.n}`, url ? link(els, url, `#${number}`) : <Text dimColor>{`#${number}`}</Text>)}
        {c.confidence !== 'proven' && <Text dimColor>?</Text>}
        {origin && <Text color={origin.color}>{origin.text}</Text>}
        {tag && <Text color={tag.color}>{tag.text}</Text>}
      </Box>
      <Box key={`body-${c.n}`} flexDirection="column" paddingLeft={6}>
        <Text wrap="wrap">{c.summary || c.target || ''}</Text>
        {isOpen && shown.length > 0 && (
          <Box key={`full-${c.n}`} flexDirection="column" marginTop={1} marginBottom={1}>
            {shown.flatMap(([id, label, text]) => [<Text dimColor>{label}</Text>, <Markdown key={`${id}-md-${c.n}`} text={text} />])}
          </Box>
        )}
      </Box>
      {files.length > 0 && (
        <Box key={`files-${c.n}`} flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={6}>
          {files}
        </Box>
      )}
    </Box>
  )
}

/** Comments already on GitHub, one line each: unaddressed ones wait on their author, and only addressed ones say how they were settled. */
function followUpRows(els: Els, followUp: SectionSpec, comments: Comment[], prs: readonly Pr[]) {
  const { Box, Text } = els

  return comments.map(c => {
    const { number, url } = prOf(c, prs)
    const id = `${followUp.id}-${c.n}`

    return (
      <Box key={id} flexDirection="column">
        <Box key={`${followUp.id}-row-${c.n}`} flexDirection="row" columnGap={1}>
          {fixed(els, `${followUp.id}-num-${c.n}`, <Text dimColor>{String(c.n).padStart(2)}</Text>)}
          {fixed(
            els,
            `${followUp.id}-pr-${c.n}`,
            url ? link(els, url, `#${number}`, { dimColor: true }) : <Text dimColor>{`#${number}`}</Text>,
          )}
          {c.posted_url && fixed(els, `${followUp.id}-link-${c.n}`, link(els, c.posted_url, 'comment', { color: followUp.color }))}
          <Text dimColor wrap="truncate-end">
            {c.summary || c.target || ''}
          </Text>
        </Box>
        {c.addressed && c.addressed_note && (
          <Text dimColor wrap="wrap">
            {`   ${c.addressed_note}`}
          </Text>
        )}
      </Box>
    )
  })
}

/** The report's sections, one line each until opened, so the comments stay in view. */
function reportBox($: EngineInterface, els: Els, sections: ReportSection[]) {
  const { Box, Text, Button, Markdown } = els

  return (
    <Box key="report" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
      <Box key="report-heading" flexDirection="row" columnGap={1}>
        <Text bold>Report</Text>
        <Text dimColor>{String(sections.length)}</Text>
      </Box>
      {sections.flatMap((s, i) => {
        const sid = s.id || String(i)
        const id = `r:${sid}`
        const isOpen = expanded.has(id)

        return [
          <Button
            key={`report-${sid}`}
            label={`${isOpen ? '▾ ' : '▸ '}${s.title || 'Section'}`}
            plain
            onPress={toggler($, id)}
          />,
          ...(isOpen && s.markdown
            ? [
                <Box key={`report-body-${sid}`} paddingLeft={2} marginBottom={1}>
                  <Markdown key={`report-md-${sid}`} text={s.markdown} />
                </Box>,
              ]
            : []),
        ]
      })}
    </Box>
  )
}

/** Ticking comments only drafts the reply; the person still sends it, so approval stays theirs. */
function pickBar($: EngineInterface, els: Els) {
  const { Box, Button } = els
  const picked = [...picks].sort((a, b) => a - b)
  if (picked.length === 0) return undefined
  const text = `post ${picked.join(', ')}`

  return (
    <Box key="pick-bar" flexDirection="row" columnGap={2} paddingX={1}>
      <Button
        key="fill"
        label={`Draft "${text}"`}
        plain
        onPress={async () => {
          const filled = await $.prompt.fill({ text })
          notice = filled && filled.isFilled === false ? `The prompt box is busy; type: ${text}` : undefined
          $.ui.invalidate('ui.render')
        }}
      />
      <Button
        key="clear-picks"
        label="clear"
        plain
        dimColor
        onPress={async () => {
          picks.clear()
          $.ui.invalidate('ui.render')
        }}
      />
    </Box>
  )
}

function freshness(b: Board | undefined, now: number) {
  const at = Date.parse(b?.updated_at ?? '')

  return [
    Number.isNaN(at) ? '' : `Updated ${ago(now - at)}`,
    github.checkedAt > 0 ? `GitHub checked ${ago(now - github.checkedAt)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export async function reviewStart($: EngineInterface) {
  home = (await $.env.get('HOME')) ?? ''
  sessionId = await $.session.id()
  workspaceId = await $.env.get('HERDR_WORKSPACE_ID')
  await reviewRefresh($)
  $.clock.every(POLL_MS, () => reviewRefresh($))
}

export async function reviewSync($: EngineInterface) {
  const id = await $.session.id()
  if (id === sessionId) return
  sessionId = id
  await reviewRefresh($)
}

export function reviewView($: EngineInterface): View {
  return {
    id: 'review',
    title: 'review',
    scope: 'session',
    onShow: () => reviewRefresh($),
    isAvailable: async () => review !== undefined,
    opensAtStart: async () => review !== undefined,
    needs: async () => (board ? commentsOf(board).filter(isPickable).length : 0),
    render: async els => {
      const { Box, Text } = els
      if (!review) {
        const empty = `This session runs no pr-review-board review. Any session can still fill this view by writing a board to ${manualPath}.`

        return (
          <Text dimColor wrap="wrap">
            {readError || empty}
          </Text>
        )
      }
      if (!board) {
        return (
          <Box flexDirection="column">
            <Text bold>{review.slug}</Text>
            <Text dimColor wrap="wrap">
              {readError || `No board yet for ${review.key}.`}
            </Text>
            {prList($, els, {}, [{ id: 'all', title: 'Stack', prs: review.prs }], false)}
          </Box>
        )
      }
      const b = board
      const now = await $.clock.now()
      const prs = Array.isArray(b.prs) ? b.prs : review.prs
      const comments = commentsOf(b)
      const stacks = stacksOf(b, prs)
      const stacked = stacks.length > 1
      const choice = await read($, stackChoice)
      const stack = stacked ? stacks.find(s => s.id === choice) : undefined
      const inView = stack ? comments.filter(c => stackOf(c, prs, stacks) === stack.id) : comments
      const toDecide = inView.filter(c => c.status !== 'posted' && c.status !== 'dropped')
      const posted = inView.filter(c => c.status === 'posted').sort((x, y) => x.n - y.n)
      const fresh = freshness(b, now)
      const children: RenderNode[] = [...(fresh ? [stamp(els, fresh)] : []), header(els, b, review, stack, inView)]
      if (stacked) children.push(stackTabs($, els, stacks, stack))
      children.push(prList($, els, b, stack ? [stack] : stacks, stacked && !stack))
      for (const severity of SEVERITIES) {
        const inSection = toDecide.filter(c => severityOf(c) === severity)
        if (inSection.length > 0) {
          children.push(section(els, severity, inSection.length, inSection.map(c => commentRow($, els, c, prs))))
        }
      }
      for (const followUp of FOLLOW_UPS) {
        const inSection = posted.filter(followUp.holds)
        if (inSection.length > 0) {
          children.push(section(els, followUp, inSection.length, followUpRows(els, followUp, inSection, prs)))
        }
      }
      // The report covers the whole review, so a stack's view leaves it to All
      if (!stack && Array.isArray(b.report) && b.report.length > 0) children.push(reportBox($, els, b.report))
      const picking = pickBar($, els)
      if (picking) children.push(picking)
      if (notice) {
        children.push(
          <Text key="notice" color="yellow" wrap="wrap">
            {notice}
          </Text>,
        )
      }

      return (
        <Box key="review" flexDirection="column">
          {children}
        </Box>
      )
    },
  }
}
