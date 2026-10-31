import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, On, RenderNode } from 'claude-code'

import type { CiState, PrBoard, PrFacts, TrackedPr } from '../../types'
import { ago, messageOf, prMark, prRow, span, stamp } from '../kit'
import type { Els, View } from '../kit'
import { PANE, paneFocused, showView } from '../pane'
import { legacyValue, loadBoard, saveBoard, storedBoard } from '../store'

export const PRS_TOOL = 'mcp__board__prs'

const REFRESH_MS = 60_000
// GitHub times out with HTTP 504 on one query covering a few dozen pull requests
const BATCH = 8
// Every session reads and writes what it fetched here, so a pull request several sessions track is asked about once
const CACHE_PATH = '.cache/board/github.json'
const FRESH_MS = 3 * 60_000
const KEEP_MS = 24 * 3600_000
// A session nobody has used for this long stops asking GitHub until the person comes back to it
const IDLE_MS = 30 * 60_000
// GitHub allows 5000 GraphQL points an hour across everything signed in as the person, agents and pollers included
const BUDGET_FLOOR = 1000
const PAUSE_MS = 10 * 60_000

const TOOL_DESCRIPTION = `Track the pull requests this session raised on the prs view of the board pane beside the chat. The view shows GitHub's live state for each: draft or ready, merged or closed, CI, conflicts, review, and review threads waiting on the person.
- add: a pull request this session opened or owns, by URL or owner/repo#N. Ones opened here with gh pr create or gh stack submit join on their own.
- note: one line on what is left on it, the next step or the question it waits on. Keep it current as that changes.
- stack: a short shared name for pull requests that belong together. Stacked branches group on their own.
- remove: stop tracking one.
Call with no fields to refresh from GitHub and read every tracked pull request's state. Use that rather than gh when asked where the pull requests stand. Do not mention board updates in your reply. Main conversation only.`

const ENTRY = {
  type: 'object',
  properties: {
    pr: {
      type: 'string',
      description: 'The pull request, by URL or owner/repo#N.',
    },
    note: {
      type: 'string',
      description: 'One line on what is left or open on it, given back whenever the board is read.',
    },
    stack: {
      type: 'string',
      description: 'A short name shared by pull requests that belong together.',
    },
  },
  required: ['pr'],
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    add: {
      type: 'array',
      description: 'Pull requests to track. One already tracked takes the new note or stack.',
      items: ENTRY,
    },
    update: {
      type: 'array',
      description: 'Changes to the note or stack of tracked pull requests.',
      items: ENTRY,
    },
    remove: {
      type: 'array',
      description: 'Pull requests to stop tracking, by URL or owner/repo#N.',
      items: { type: 'string' },
    },
  },
}

const OPENS_PR = /\bgh\s+(pr\s+create|stack\s+submit)\b/
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const REF = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/pull\/|#)(\d+)/
// The widest state word, so the titles line up, and the most an author's login takes
const STATE_WIDTH = 8
const MAX_AUTHOR = 12
const cutTo = (text: string, room: number) => ([...text].length <= room ? text : `${[...text].slice(0, room - 1).join('')}…`)

const CI_WORDS: Record<CiState, string> = { pass: 'passing', fail: 'failing', pending: 'running', none: 'not run' }
const FAILED_RUNS = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

const PR_FIELDS = `title state isDraft mergeable mergeStateStatus reviewDecision
  headRefName baseRefName headRefOid author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status conclusion startedAt completedAt
      checkSuite { workflowRun { runNumber event workflow { databaseId } } } } ... on StatusContext { context state createdAt } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved comments(last: 50) { nodes { author { login } url } } } }
  latestReviews(first: 20) { nodes { author { login } state } }`

type Ref = Pick<TrackedPr, 'key' | 'owner' | 'repo' | 'number' | 'url'>
type Entry = { pr: string; note?: string; stack?: string }
type Input = { add?: Entry[]; update?: Entry[]; remove?: string[] }
type Applied = { board: PrBoard; added: string[] } | { error: string }
/** A group of pull requests: `chains` holds each git stack bottom first, a lone pull request as a chain of one. */
type Stack = { title: string; prs: TrackedPr[]; chains: TrackedPr[][] }
type Need = { text: string; href?: string }
type Word = { text: string; color?: Color; isDim?: boolean }

type Login = { login: string } | null
type GqlCheck = {
  __typename: string
  name?: string
  status?: string
  conclusion?: string | null
  startedAt?: string | null
  completedAt?: string | null
  context?: string
  state?: string
  createdAt?: string
  checkSuite?: { workflowRun: WorkflowRun | null } | null
}
type WorkflowRun = { runNumber: number; event: string; workflow: { databaseId: number } }
type GqlPr = {
  title: string
  state: PrFacts['state']
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  headRefName: string
  baseRefName: string
  headRefOid: string
  author: Login
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: { state: string; contexts: { nodes: GqlCheck[] } } | null
      }
    }[]
  }
  reviewThreads: {
    nodes: { isResolved: boolean; comments: { nodes: { author: Login; url: string }[] } }[]
  }
  latestReviews: { nodes: { author: Login; state: string }[] }
}
type GqlAnswer = { data?: Record<string, unknown>; errors?: { message: string }[] }

const emptyBoard = (sessionId: string): PrBoard => ({
  sessionId,
  prs: [],
  viewer: '',
  checkedAt: 0,
  error: '',
})

const SHAPE = 'prs-1'
const board = atom({ plugin: 'board', key: 'prs' } as const, emptyBoard(''), { shape: SHAPE })
const PREFIX = 'prs'

/** Every pull request on any session's saved prs board, once each, from the store as `storedValues` read it. */
export function storedPrs(held: Record<string, unknown>): TrackedPr[] {
  const out = new Map<string, TrackedPr>()
  for (const key of Object.keys(held)) {
    if (!key.startsWith(`${PREFIX}:`)) continue
    const saved = storedBoard<PrBoard>(held, PREFIX, SHAPE, key.slice(PREFIX.length + 1))
    for (const p of saved?.prs ?? []) if (!out.has(p.key)) out.set(p.key, p)
  }

  return [...out.values()]
}

// session.start fires once per process, not after /clear or /resume, so every entry point re-checks the session
async function syncBoard($: EngineInterface) {
  const sessionId = await $.session.id()
  if ((await read($, board)).sessionId !== sessionId) {
    const loaded = (await loadBoard<PrBoard>($, PREFIX, SHAPE, sessionId)) ?? emptyBoard(sessionId)
    await update($, board, () => loaded)
  }
  await importLegacy($)
}

/**
 * The my-pr-board plugin kept a board per session in its own store. The first sync of a session takes in the pull
 * requests that board tracked and this one does not, and fills a note or stack this board left empty.
 */
async function importLegacy($: EngineInterface) {
  const current = await read($, board)
  if (current.legacyImported) return
  let held: unknown
  try {
    held = await legacyValue($, 'my-pr-board', `board:${current.sessionId}`)
  } catch {
    return
  }
  const old = (held as { shape?: string; value?: PrBoard } | undefined)?.shape === SHAPE
    ? (held as { value: PrBoard }).value
    : undefined
  await update($, board, now => (now.sessionId === current.sessionId ? withLegacy(now, old) : now))
  if (old) await saveBoard($, PREFIX, SHAPE, await read($, board))
}

function withLegacy(current: PrBoard, old: PrBoard | undefined): PrBoard {
  if (!old) return { ...current, legacyImported: true }
  const theirs = new Map(old.prs.map(p => [p.key, p]))
  const prs = current.prs.map(p => {
    const was = theirs.get(p.key)

    return was ? { ...p, note: p.note || was.note, stack: p.stack || was.stack } : p
  })
  const tracked = new Set(prs.map(p => p.key))

  return {
    ...current,
    prs: [...prs, ...old.prs.filter(p => !tracked.has(p.key))],
    viewer: current.viewer || old.viewer,
    legacyImported: true,
  }
}

function refOf(text: string): Ref | undefined {
  const [, owner, repo, number] = REF.exec(text.trim()) ?? []
  if (!owner || !repo || !number) return undefined

  return {
    key: `${owner}/${repo}#${number}`.toLowerCase(),
    owner,
    repo,
    number: Number(number),
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  }
}

const nameOf = (p: TrackedPr) => `${p.owner}/${p.repo}#${p.number}`

function apply(current: PrBoard, input: Input): Applied {
  const entries = [...(input.add ?? []), ...(input.update ?? [])]
  const named = [...entries.map(one => String(one.pr)), ...(input.remove ?? []).map(String)]
  const refs = new Map(named.map(pr => [pr, refOf(pr)]))
  const bad = named.filter(pr => !refs.get(pr))
  if (bad.length > 0) {
    return { error: `Not a pull request: ${bad.join(', ')}. Give a URL or owner/repo#N.` }
  }
  const keyOf = (pr: string) => (refs.get(pr) as Ref).key
  const tracked = new Set(current.prs.map(p => p.key))
  const unknown = [...(input.update ?? []).map(one => one.pr), ...(input.remove ?? [])].filter(
    pr => !tracked.has(keyOf(pr)),
  )
  if (unknown.length > 0) {
    return { error: `Not tracked: ${unknown.join(', ')}. Call with no fields to list them.` }
  }

  const removed = new Set((input.remove ?? []).map(keyOf))
  const prs = current.prs.filter(p => !removed.has(p.key))
  const added: string[] = []
  for (const one of entries) {
    const ref = refs.get(one.pr) as Ref
    const at = prs.findIndex(p => p.key === ref.key)
    const existing = prs[at]
    if (!existing) {
      const fresh = { ...ref, note: one.note ?? '', stack: one.stack ?? '' }
      prs.push(fresh)
      added.push(nameOf(fresh))
      continue
    }
    prs[at] = {
      ...existing,
      ...(one.note !== undefined && { note: one.note }),
      ...(one.stack !== undefined && { stack: one.stack }),
    }
  }

  return { board: { ...current, prs }, added }
}

// Graphite's check stays in progress until the pull requests below it in its stack merge: an order to merge in, which
// the stack drawing shows, not CI
const NOT_CI = new Set(['Graphite / mergeability_check'])

// A run not started yet is the newest of its check
const startOf = (check: GqlCheck) =>
  check.startedAt ?? (check.status === 'COMPLETED' ? check.completedAt : undefined) ?? check.createdAt ?? '\uffff'
const workflowOf = (run: WorkflowRun) => `${run.workflow.databaseId} ${run.event}`

/**
 * CI as GitHub's checks list shows it, by the latest run of each workflow and the latest run of each check. The
 * commit's rollup state counts every run, so a run a newer one replaced keeps it failed: a workflow run its
 * concurrency group cancelled leaves cancelled jobs the newer run has not reached yet.
 */
function ciOf(rollup: GqlPr['commits']['nodes'][number]['commit']['statusCheckRollup']) {
  if (!rollup) return { ci: 'none' as CiState, failing: [] }
  const newest = new Map<string, number>()
  for (const check of rollup.contexts.nodes) {
    const run = check.checkSuite?.workflowRun
    if (run) newest.set(workflowOf(run), Math.max(newest.get(workflowOf(run)) ?? 0, run.runNumber))
  }
  const latest = new Map<string, GqlCheck>()
  for (const check of rollup.contexts.nodes) {
    const name = check.name ?? check.context ?? 'a check'
    const run = check.checkSuite?.workflowRun
    if (NOT_CI.has(name) || (run && run.runNumber < (newest.get(workflowOf(run)) ?? 0))) continue
    const seen = latest.get(name)
    if (!seen || startOf(check) >= startOf(seen)) latest.set(name, check)
  }
  const checks = [...latest]
  const failing = checks
    .filter(([, check]) =>
      check.__typename === 'CheckRun'
        ? FAILED_RUNS.includes(check.conclusion ?? '')
        : check.state === 'FAILURE' || check.state === 'ERROR',
    )
    .map(([name]) => name)
  const isRunning = checks.some(([, check]) =>
    check.__typename === 'CheckRun' ? check.status !== 'COMPLETED' : check.state === 'PENDING' || check.state === 'EXPECTED',
  )
  const ci: CiState = failing.length > 0 ? 'fail' : isRunning ? 'pending' : 'pass'

  return { ci, failing }
}

/**
 * An open thread whose last comment is someone else's waits on the pull request's author. On someone else's pull
 * request it waits on the viewer only when they commented in it; the rest are between its author and other reviewers.
 */
function factsOf(pr: GqlPr, viewer: string): PrFacts {
  const author = pr.author?.login ?? ''
  const isOwn = !viewer || author.toLowerCase() === viewer.toLowerCase()
  const waiting = pr.reviewThreads.nodes
    .filter(thread => !thread.isResolved)
    .map(thread => thread.comments.nodes)
    .filter(comments => isOwn || comments.some(comment => comment.author?.login === viewer))
    .map(comments => comments.at(-1))
    .filter(last => last && last.author?.login !== viewer)
  const reviewers = (state: string) =>
    pr.latestReviews.nodes
      .filter(review => review.state === state && review.author)
      .map(review => (review.author as { login: string }).login)

  return {
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    review: pr.reviewDecision ?? '',
    approvedBy: reviewers('APPROVED'),
    changesRequestedBy: reviewers('CHANGES_REQUESTED'),
    ...ciOf(pr.commits.nodes[0]?.commit.statusCheckRollup ?? null),
    author,
    head: pr.headRefName,
    base: pr.baseRefName,
    headSha: pr.headRefOid,
    waiting: waiting.length,
    ...(waiting[0] && { waitingUrl: waiting[0].url }),
  }
}

const isConflicted = (f: PrFacts) => f.mergeable === 'CONFLICTING' || f.mergeState === 'DIRTY'

/**
 * GitHub's review decision, or in a repo that requires no review, where GitHub gives none, the one the latest reviews
 * make. Read here rather than stored, since sessions of every version share the facts they fetch.
 */
function reviewOf(f: PrFacts): string {
  if (f.review) return f.review
  if (f.changesRequestedBy.length > 0) return 'CHANGES_REQUESTED'

  return f.approvedBy.length > 0 ? 'APPROVED' : ''
}

function transitions(p: TrackedPr, now: PrFacts): string[] {
  const was = p.facts
  if (!was) return []
  const name = `#${p.number}`
  const out: string[] = []
  if (was.state !== now.state && now.state === 'MERGED') out.push(`${name} merged`)
  if (was.state !== now.state && now.state === 'CLOSED') out.push(`${name} was closed`)
  if (was.ci !== 'fail' && now.ci === 'fail') {
    out.push(`${name} CI failed: ${now.failing[0] ?? 'a check'}`)
  }
  if (was.ci === 'pending' && now.ci === 'pass') out.push(`${name} CI passed`)
  if (!isConflicted(was) && isConflicted(now)) out.push(`${name} has conflicts`)
  if (now.waiting > was.waiting) out.push(`${name} has a new thread waiting on you`)
  if (reviewOf(was) !== reviewOf(now) && reviewOf(now) === 'APPROVED') out.push(`${name} approved`)
  if (reviewOf(was) !== reviewOf(now) && reviewOf(now) === 'CHANGES_REQUESTED') {
    out.push(`${name} has changes requested`)
  }

  return out
}

const repoOf = (p: TrackedPr) => `${p.owner}/${p.repo}`.toLowerCase()
const branchKey = (p: TrackedPr, branch: string) => `${repoOf(p)}:${branch}`

/** The tracked pull request whose head branch this one is based on. */
function belowOf(p: TrackedPr, prs: readonly TrackedPr[]): TrackedPr | undefined {
  if (!p.facts) return undefined
  const base = branchKey(p, p.facts.base)

  return prs.find(other => other !== p && other.facts && branchKey(other, other.facts.head) === base)
}

/**
 * Each git stack as one run from its bottom up, in the order its bottom was tracked, then the lone pull requests. A
 * branch that two layers are based on keeps both above it in the one run.
 */
function chainsOf(members: TrackedPr[]): TrackedPr[][] {
  const below = new Map(members.map(p => [p, belowOf(p, members)]))
  const above = (p: TrackedPr) => members.filter(other => below.get(other) === p)
  const seen = new Set<TrackedPr>()
  const run = (p: TrackedPr): TrackedPr[] => {
    if (seen.has(p)) return []
    seen.add(p)

    return [p, ...above(p).flatMap(run)]
  }
  const bottoms = members.filter(p => !below.get(p))
  const stacks = bottoms.filter(p => above(p).length > 0).map(run)
  // Layers whose bases loop have no bottom; each loop is drawn as a run of its own
  const looped = members.filter(p => below.get(p) && !seen.has(p)).map(run).filter(one => one.length > 0)
  const lone = bottoms.filter(p => above(p).length === 0).map(p => [p])

  return [...stacks, ...looped, ...lone]
}

/** Stacked branches and pull requests sharing a stack name each form one stack, bottom first. */
function stacksOf(prs: readonly TrackedPr[]): Stack[] {
  const parent = new Map(prs.map(p => [p.key, p.key]))
  const find = (key: string): string => {
    let at = key
    while (parent.get(at) !== at) at = parent.get(at) as string
    return at
  }
  const join = (a: string, b: string) => parent.set(find(a), find(b))
  const firstNamed = new Map<string, string>()
  for (const p of prs) {
    const below = belowOf(p, prs)
    if (below) join(p.key, below.key)
    if (!p.stack) continue
    const first = firstNamed.get(p.stack)
    if (first) join(p.key, first)
    else firstNamed.set(p.stack, p.key)
  }
  const groups = new Map<string, TrackedPr[]>()
  for (const p of prs) {
    const root = find(p.key)
    groups.set(root, [...(groups.get(root) ?? []), p])
  }

  return [...groups.values()].map(members => {
    const chains = chainsOf(members)

    return { title: members.find(p => p.stack)?.stack ?? '', prs: chains.flat(), chains }
  })
}

/** What a pull request waits on the person for, one line each; none once it merged or closed. */
export function needsOf(p: TrackedPr): Need[] {
  if (p.error) return [{ text: `could not be read: ${p.error}` }]
  const f = p.facts
  if (!f || f.state !== 'OPEN') return []
  const out: Need[] = []
  if (f.ci === 'fail') {
    const more = f.failing.length > 1 ? ` and ${f.failing.length - 1} more` : ''
    out.push({ text: `CI failing: ${f.failing[0] ?? 'a check'}${more}` })
  }
  if (isConflicted(f)) {
    out.push({
      text: f.ci === 'pass' ? 'conflicts with its base, so its green CI is stale' : 'conflicts with its base',
    })
  } else if (f.mergeState === 'BEHIND') {
    out.push({ text: 'is behind its base' })
  }
  if (reviewOf(f) === 'CHANGES_REQUESTED') {
    const by = f.changesRequestedBy.length > 0 ? ` by ${f.changesRequestedBy.join(', ')}` : ''
    out.push({ text: `has changes requested${by}` })
  }
  if (f.waiting > 0) {
    out.push({
      text: `${f.waiting} review thread${f.waiting === 1 ? '' : 's'} waiting on you`,
      ...(f.waitingUrl && { href: f.waitingUrl }),
    })
  }

  return out
}

/**
 * The person's own pull request needs them for anything `needsOf` finds. Someone else's, which a session only
 * watches, needs them only for a review thread waiting on them: its CI and conflicts are its author's to fix.
 */
export function needsYou(p: TrackedPr, viewer: string): boolean {
  const f = p.facts
  if (p.error || !f) return Boolean(p.error)
  const isOwn = !viewer || f.author.toLowerCase() === viewer.toLowerCase()

  return isOwn ? needsOf(p).length > 0 : f.state === 'OPEN' && f.waiting > 0
}

function stateOf(p: TrackedPr): Word {
  const f = p.facts
  if (!f) return { text: '', isDim: true }
  if (f.state === 'MERGED') return { text: 'merged', color: 'merged' }
  if (f.state === 'CLOSED') return { text: 'closed', isDim: true }
  if (f.isDraft) return { text: 'draft', isDim: true }
  if (isConflicted(f)) return { text: 'conflict', color: 'error' }
  if (f.ci === 'fail') return { text: 'CI fail', color: 'error' }
  if (f.ci === 'pending') return { text: 'CI run', color: 'warning' }
  if (f.mergeState === 'BEHIND') return { text: 'behind', color: 'warning' }
  const review = reviewOf(f)
  if (review === 'CHANGES_REQUESTED') return { text: 'changes', color: 'error' }

  return review === 'APPROVED' ? { text: 'ready', color: 'success' } : { text: 'review', color: 'suggestion' }
}

/** CI and mergeability as one dot: red when it cannot merge as it stands, yellow while CI runs. */
function healthOf(p: TrackedPr): Color {
  const f = p.facts
  if (p.error) return 'error'
  if (!f || f.state !== 'OPEN') return 'inactive'
  if (f.ci === 'fail' || isConflicted(f)) return 'error'
  if (f.ci === 'pending') return 'warning'

  return f.ci === 'pass' ? 'success' : 'inactive'
}

/** Headed stacks first, then the pull requests in none, under "Other" once anything is headed. */
function groupsOf(prs: readonly TrackedPr[]): Stack[] {
  const stacks = stacksOf(prs)
  const headed = stacks
    .filter(stack => stack.title !== '' || stack.prs.length > 1)
    .map(stack => ({ ...stack, title: stack.title || 'Stack' }))
  const loose = stacks.filter(stack => stack.title === '' && stack.prs.length === 1).flatMap(stack => stack.prs)
  if (loose.length === 0) return headed

  return [...headed, { title: headed.length > 0 ? 'Other' : '', prs: loose, chains: loose.map(p => [p]) }]
}

const checkedLine = (b: PrBoard, now: number) => {
  if (b.error) return `GitHub check failed: ${b.error}`

  return b.checkedAt ? `GitHub checked ${ago(now - b.checkedAt)}` : 'Checking GitHub'
}

function describe(b: PrBoard, now: number): string {
  if (b.prs.length === 0) return 'No pull requests tracked.'
  const lines = [checkedLine(b, now)]
  for (const group of groupsOf(b.prs)) {
    const indent = group.title ? '  ' : ''
    if (indent) lines.push(`${group.title}:`)
    for (const p of group.prs) {
      const below = belowOf(p, b.prs)
      const ci = p.facts?.state === 'OPEN' && p.facts.ci !== 'fail' ? `CI ${CI_WORDS[p.facts.ci]}` : ''
      const status = [
        stateOf(p).text || 'checking GitHub',
        p.facts?.author ? `by ${p.facts.author}` : '',
        below ? `on #${below.number}` : '',
        ci,
        ...needsOf(p).map(need => (need.href ? `${need.text} <${need.href}>` : need.text)),
      ].filter(Boolean)
      lines.push(`${indent}${nameOf(p)}${p.facts ? ` ${p.facts.title}` : ''}`, `${indent}  ${status.join(', ')}`)
      if (p.note) lines.push(`${indent}  note: ${p.note}`)
    }
  }

  return lines.join('\n')
}

async function change($: EngineInterface, fn: (current: PrBoard) => Applied): Promise<Applied> {
  const out: { applied?: Applied } = {}
  await update($, board, current => {
    out.applied = fn(current)

    return 'board' in out.applied ? out.applied.board : current
  })

  return out.applied ?? { error: 'The board did not change.' }
}

type Cached = { facts?: PrFacts; at: number; v?: number }

// Raised when facts are derived from GitHub differently: an entry a session on an older board wrote is fetched again
// rather than shown
const FACTS_VERSION = 3
type Cache = { prs: Record<string, Cached>; viewer?: string; pausedUntil?: number; pauseReason?: string }
type Budget = { remaining: number; resetAt: string }

const RATE_LIMITED = /rate limit/i

async function cachePath($: EngineInterface) {
  return `${await $.env.get('HOME')}/${CACHE_PATH}`
}

async function readCache($: EngineInterface, path: string): Promise<Cache> {
  try {
    if (!(await $.fs.exists(path))) return { prs: {} }
    const cache = JSON.parse(await $.fs.read(path)) as Cache

    return { ...cache, prs: cache.prs ?? {} }
  } catch {
    // Another session may be mid-write; what it wrote is fetched again rather than waited for
    return { prs: {} }
  }
}

/** The facts every session has cached, by pull request key, and the GitHub login they were read as. */
export async function cachedFacts($: EngineInterface): Promise<{ facts: Map<string, PrFacts>; viewer: string }> {
  const cache = await readCache($, await cachePath($))
  const facts = new Map(Object.entries(cache.prs).flatMap(([key, one]) => (one.facts ? [[key, one.facts] as const] : [])))

  return { facts, viewer: cache.viewer ?? '' }
}

/** Reads the file again just before writing, so what other sessions wrote meanwhile stays. */
async function writeCache($: EngineInterface, path: string, change: (cache: Cache) => Cache) {
  try {
    await $.fs.write(path, JSON.stringify(change(await readCache($, path))))
  } catch {
    // An unwritten cache only means another session asks GitHub again
  }
}

/** Facts for one batch of pull requests, keyed by pull request; undefined for one GitHub no longer has. */
async function fetchBatch($: EngineInterface, prs: readonly TrackedPr[], viewer: string) {
  const parts = prs.map(
    (p, at) =>
      `p${at}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) { pullRequest(number: ${p.number}) { ...F } }`,
  )
  const query = `query { rateLimit { remaining resetAt } viewer { login } ${parts.join(' ')} } fragment F on PullRequest { ${PR_FIELDS} }`
  const ran = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`], {
    timeoutMs: 30_000,
  })
  let answer: GqlAnswer = {}
  try {
    answer = JSON.parse(ran.stdout) as GqlAnswer
  } catch {
    // gh printed no JSON; its stderr says why
  }
  const data = answer.data
  if (!data) {
    const why = ran.stderr.trim().split('\n')[0] || answer.errors?.[0]?.message
    throw new Error(why || `gh exited ${ran.exitCode}`)
  }
  const login = (data.viewer as { login?: string } | undefined)?.login ?? viewer
  const found = new Map(
    prs.map((p, at) => {
      const node = data[`p${at}`] as { pullRequest: GqlPr | null } | null | undefined
      return [p.key, node?.pullRequest ? factsOf(node.pullRequest, login) : undefined] as const
    }),
  )

  return { viewer: login, found, budget: data.rateLimit as Budget | undefined }
}

/**
 * Every pull request's facts: from the shared cache while fresh, else from GitHub in batches. A merged pull request
 * no longer changes, so it keeps the facts it has. A batch GitHub fails leaves its pull requests as they were and says
 * so in `error`, and while the rate limit runs low no session asks at all.
 */
async function fetchFacts($: EngineInterface, b: { prs: readonly TrackedPr[]; viewer: string }, mayAsk = true) {
  const path = await cachePath($)
  const cache = await readCache($, path)
  const now = await $.clock.now()
  const found = new Map<string, PrFacts | undefined>()
  let oldest = now
  for (const p of b.prs) {
    const cached = cache.prs[p.key]
    const isFinal = cached?.facts?.state === 'MERGED'
    if (!cached || (!isFinal && (now - cached.at >= FRESH_MS || cached.v !== FACTS_VERSION))) continue
    found.set(p.key, cached.facts)
    // A merged pull request's facts are final however old, so only the ones that can change date the check
    if (!isFinal) oldest = Math.min(oldest, cached.at)
  }
  const due = b.prs.filter(p => !found.has(p.key) && p.facts?.state !== 'MERGED')
  const viewer = cache.viewer || b.viewer
  if (due.length === 0 || !mayAsk) return { viewer, found, error: '', checkedAt: oldest }
  if ((cache.pausedUntil ?? 0) > now) {
    const error = `${cache.pauseReason ?? 'rate limit low'}, retrying in ${span(cache.pausedUntil as number - now)}`

    return { viewer, found, error, checkedAt: oldest }
  }

  const batches: TrackedPr[][] = []
  for (let at = 0; at < due.length; at += BATCH) batches.push(due.slice(at, at + BATCH))
  const settled = await Promise.allSettled(batches.map(batch => fetchBatch($, batch, viewer)))
  const fetched = new Map<string, PrFacts | undefined>()
  let login = viewer
  let missed = 0
  let why = ''
  let budget: Budget | undefined
  settled.forEach((one, at) => {
    if (one.status === 'fulfilled') {
      login = one.value.viewer
      budget = one.value.budget ?? budget
      for (const [key, facts] of one.value.found) fetched.set(key, facts)
      return
    }
    missed += batches[at]?.length ?? 0
    why ||= messageOf(one.reason)
  })
  const resetAt = budget ? Date.parse(budget.resetAt) : NaN
  const pause =
    budget && budget.remaining < BUDGET_FLOOR && !Number.isNaN(resetAt)
      ? { pausedUntil: resetAt, pauseReason: 'rate limit low' }
      : RATE_LIMITED.test(why)
        ? { pausedUntil: now + PAUSE_MS, pauseReason: 'rate limit reached' }
        : undefined
  await writeCache($, path, current => {
    const prs: Record<string, Cached> = {}
    for (const [key, entry] of Object.entries(current.prs)) if (now - entry.at < KEEP_MS) prs[key] = entry
    for (const [key, facts] of fetched) prs[key] = facts ? { facts, at: now, v: FACTS_VERSION } : { at: now, v: FACTS_VERSION }
    const { pausedUntil, pauseReason, ...rest } = current
    const held = (pausedUntil ?? 0) > now ? { pausedUntil, pauseReason } : {}

    return { ...rest, ...held, ...pause, prs, viewer: login }
  })
  for (const [key, facts] of fetched) found.set(key, facts)
  if (missed > 0 && missed === due.length) throw new Error(why)
  const error = missed > 0 ? `${why}, ${missed} of ${due.length} pull requests not refreshed` : ''

  return { viewer: login, found, error, checkedAt: fetched.size > 0 ? oldest : now }
}

async function refreshNow($: EngineInterface) {
  await syncBoard($)
  const b = await read($, board)
  if (b.prs.length === 0) return
  try {
    const { viewer, found, error, checkedAt } = await fetchFacts($, b)
    const toasts = b.prs.flatMap(p => {
      const facts = found.get(p.key)
      return facts ? transitions(p, facts) : []
    })
    await update($, board, current => {
      if (current.sessionId !== b.sessionId) return current
      const prs = current.prs.map((p): TrackedPr => {
        if (!found.has(p.key)) return p
        const facts = found.get(p.key)
        const { error, ...rest } = p
        return facts ? { ...rest, facts } : { ...rest, error: 'Not found on GitHub.' }
      })

      return { ...current, prs, viewer, checkedAt, error }
    })
    for (const text of toasts) $.ui.toast(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, board, current => (current.sessionId === b.sessionId ? { ...current, error: message } : current))
  }
  await saveBoard($, PREFIX, SHAPE, await read($, board))
}

let queue: Promise<void> = Promise.resolve()
let lastActive = 0

async function markActive($: EngineInterface) {
  lastActive = await $.clock.now()
}

/** Refreshes run one at a time, each reading the board as it stands when it starts. */
function refresh($: EngineInterface): Promise<void> {
  queue = queue.then(() => refreshNow($)).catch(() => undefined)

  return queue
}

export type GithubFacts = { facts: Map<string, PrFacts>; viewer: string; checkedAt: number; error: string }

/**
 * GitHub's facts for pull requests another view lists, through this board's cache and queue, so a pull request both
 * show is asked about once. GitHub is asked only while the session is in use; the facts `prs` carry stand in for any
 * it does not give.
 */
export function factsFor($: EngineInterface, prs: readonly TrackedPr[], viewer: string): Promise<GithubFacts> {
  const known = new Map(prs.flatMap(p => (p.facts ? [[p.key, p.facts] as const] : [])))
  const asked = queue.then(async (): Promise<GithubFacts> => {
    try {
      const mayAsk = (await $.clock.now()) - lastActive <= IDLE_MS
      const got = await fetchFacts($, { prs, viewer }, mayAsk)
      for (const [key, facts] of got.found) if (facts) known.set(key, facts)

      return { facts: known, viewer: got.viewer, checkedAt: got.checkedAt, error: got.error }
    } catch (err) {
      return { facts: known, viewer, checkedAt: 0, error: messageOf(err) }
    }
  })
  queue = asked.then(() => undefined)

  return asked
}

const CHAIN_GLYPHS = { first: '┌', mid: '├', last: '└', none: '' } as const

function chainOf(chains: readonly TrackedPr[][], p: TrackedPr): keyof typeof CHAIN_GLYPHS {
  const run = chains.find(one => one.includes(p)) ?? [p]
  const at = run.indexOf(p)
  if (run.length < 2) return 'none'

  return at === 0 ? 'first' : at === run.length - 1 ? 'last' : 'mid'
}

/** Pull requests under one heading; `chains` as `chainsOf` gives them, worked out from `prs` when left out. */
export type PrGroup = { key: string; heading?: RenderNode; prs: readonly TrackedPr[]; chains?: TrackedPr[][] }

/**
 * Each group under its heading, one line per pull request: where it sits in its git stack, a check once approved, a
 * mark while it needs the person, its number, a dot for CI and mergeability, its state, its author and its title. A
 * layer based on something other than the row above names its base. The columns line up across groups. `titleOf`
 * gives a view's own short title in place of GitHub's.
 */
export function prTable(
  els: Els,
  groups: readonly PrGroup[],
  viewer: string,
  titleOf: (p: TrackedPr) => string | undefined = () => undefined,
): RenderNode[] {
  const { Box, Text } = els
  const laid = groups.map(group => {
    const chains = group.chains ?? chainsOf([...group.prs])

    return { group, chains, prs: chains.flat() }
  })
  const hasChains = laid.some(one => one.chains.some(run => run.length > 1))
  const authors = laid.flatMap(one => one.prs.map(p => [...(p.facts?.author ?? '')].length))
  const authorWidth = Math.min(MAX_AUTHOR, Math.max(0, ...authors))

  return laid.map(({ group, chains, prs }, at) => (
    <Box key={group.key} flexDirection="column" marginTop={at > 0 ? 1 : 0}>
      {group.heading}
      {prs.map((p, row) => {
        const below = belowOf(p, prs)
        const named = below && prs[row - 1] !== below ? below : undefined
        const state = stateOf(p)
        const mark = prMark(p.facts?.state, p.facts ? reviewOf(p.facts) === 'APPROVED' : false)

        return prRow(els, {
          id: p.key,
          number: p.number,
          url: p.url,
          ...(hasChains && { chain: CHAIN_GLYPHS[chainOf(chains, p)] }),
          ...(mark && { mark }),
          isFlagged: needsYou(p, viewer),
          dot: healthOf(p),
          columns: [
            <Box key={`state-${p.key}`} width={STATE_WIDTH} flexShrink={0}>
              <Text color={state.color} dimColor={state.isDim}>
                {state.text}
              </Text>
            </Box>,
            ...(authorWidth > 0
              ? [
                  <Box key={`author-${p.key}`} width={authorWidth} flexShrink={0}>
                    <Text dimColor>{cutTo(p.facts?.author ?? '', authorWidth)}</Text>
                  </Box>,
                ]
              : []),
          ],
          ...(named && { on: named.number }),
          title: titleOf(p) || p.facts?.title || `${p.owner}/${p.repo}`,
        })
      })}
    </Box>
  ))
}

function prsBox(els: Els, groups: Stack[], viewer: string) {
  const { Box, Text } = els
  const table = groups.map((group, at) => ({
    key: `group-${at}`,
    ...(group.title !== '' && { heading: <Text bold>{group.title}</Text> }),
    prs: group.prs,
    chains: group.chains,
  }))

  return (
    <Box key="prs" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
      {prTable(els, table, viewer)}
    </Box>
  )
}

async function track($: EngineInterface, urls: string[]): Promise<string[]> {
  await syncBoard($)
  const applied = await change($, current => apply(current, { add: urls.map(pr => ({ pr })) }))
  if ('error' in applied) return []
  await saveBoard($, PREFIX, SHAPE, applied.board)
  await showView($, 'prs')
  void refresh($)

  return applied.added
}

export function prsHooks(on: On) {
  on('tool.check', { tool: PRS_TOOL }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: PRS_TOOL }, async ($, e) => {
    if (e.agentId) return { deny: 'The prs board belongs to the main conversation.' }
    const { tool, tool_use_id, consent, agentId, ...args } = e
    const input = args as Input
    await syncBoard($)

    const isRead = !input.add?.length && !input.update?.length && !input.remove?.length
    if (!isRead) {
      const applied = await change($, current => apply(current, input))
      if ('error' in applied) return { deny: applied.error }
      await saveBoard($, PREFIX, SHAPE, applied.board)
      await showView($, 'prs')
      if (applied.added.length === 0) return { result: 'Board updated.' }
    }
    await refresh($)

    return { result: describe(await read($, board), await $.clock.now()) }
  })

  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    foldFilters($, e.element)

    return next(e)
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    foldFilters($, e.element)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !OPENS_PR.test(e.command)) return ran
    const stdout = (ran.result as { stdout?: unknown } | undefined)?.stdout
    const output = ran.text ?? (typeof stdout === 'string' ? stdout : '')
    const urls = [...new Set(output.match(PR_URL) ?? [])]
    if (urls.length === 0) return ran
    const added = await track($, urls)
    if (added.length === 0 || e.agentId) return ran

    return {
      ...ran,
      context: [...(ran.context ?? []), `The board now tracks ${added.join(', ')}. Give each a note with ${PRS_TOOL}.`],
    }
  }).catch(($, e, next) => next(e))
}

export async function prsStart($: EngineInterface) {
  await $.tool.register({
    name: 'prs',
    description: TOOL_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isDeferred: false,
  })
  await syncBoard($)
  if ((await read($, board)).prs.length > 0) void refresh($)
  await markActive($)
  $.clock.every(REFRESH_MS, async () => {
    if ((await $.clock.now()) - lastActive > IDLE_MS) return
    const b = await read($, board)
    if (b.prs.some(p => !p.facts || p.facts.state === 'OPEN')) await refresh($)
  })
}

/** Runs at every turn and command, so it also marks the session in use. */
export async function prsSync($: EngineInterface) {
  await markActive($)
  await syncBoard($)
}

type FilterField = 'author' | 'repo'

/** What the person filtered the view to, for the session `filterFor` names: empty sets show every pull request. */
const picked: Record<FilterField, Set<string>> = { author: new Set(), repo: new Set() }
let openFilter: FilterField | '' = ''
let filterFor = ''
let wasFocused = false

/** Folds the open popup on a press or a focus move anywhere but the filters themselves, as a click off it. */
function foldFilters($: EngineInterface, element: string | undefined) {
  if (openFilter === '' || (element !== undefined && /^pf(ilter|opt|clear)-/.test(element))) return
  openFilter = ''
  $.ui.invalidate('ui.render')
}

const valueOf = (p: TrackedPr, field: FilterField) => (field === 'author' ? (p.facts?.author ?? '') : p.repo)

const FILTER_TITLES: Record<FilterField, string> = { author: 'Author', repo: 'Repo' }
const FILTER_GAP = 2
// The filter boxes sit on the view's second row, under the freshness stamp
const FILTER_ROW = 1

/**
 * A box per field that has more than one value, and the open one's values in a popup over the rows below, each
 * pressed to tick or untick it; pressing the box again folds them. The popup pads every line to its full width, since
 * cells it leaves blank show the rows beneath.
 */
function filters($: EngineInterface, els: Els, prs: readonly TrackedPr[]): { row?: RenderNode; popup?: RenderNode } {
  const { Box, Button, Text } = els
  const fields = (['author', 'repo'] as const).filter(field => new Set(prs.map(p => valueOf(p, field))).size > 1)
  if (fields.length === 0) return {}
  const redraw = () => $.ui.invalidate('ui.render')
  const shown = (field: FilterField) => {
    const set = picked[field]
    if (set.size === 0) return 'all'

    return set.size === 1 ? [...set][0] : `${set.size} picked`
  }
  const labelOf = (field: FilterField) => `${FILTER_TITLES[field]}: ${shown(field)} ${openFilter === field ? '▴' : '▾'}`
  const row = (
    <Box key="pfilter-row" flexDirection="row" columnGap={FILTER_GAP} paddingX={1}>
      {fields.map(field => (
        <Button
          key={`pfilter-${field}`}
          label={labelOf(field)}
          onPress={() => {
            openFilter = openFilter === field ? '' : field
            redraw()
          }}
        />
      ))}
    </Box>
  )
  const field = openFilter
  if (field === '' || !fields.includes(field)) return { row }

  const counts = new Map<string, number>()
  for (const p of prs) counts.set(valueOf(p, field), (counts.get(valueOf(p, field)) ?? 0) + 1)
  const values = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const lines = values.map(([value, count]) => `${value || 'unknown'} ${count}`)
  const inner = Math.max(5, ...lines.map(line => [...line].length)) + 2
  // A box is drawn as `[ label ]`, four cells wider than its label. The popup's border sits one cell left of the box's
  // bracket, over the list's own border.
  const before = fields.slice(0, fields.indexOf(field)).reduce((n, one) => n + [...labelOf(one)].length + 4 + FILTER_GAP, 0)
  const popup = (
    <Box
      key="pfilter-popup"
      position="absolute"
      top={FILTER_ROW + 1}
      left={before}
      flexDirection="column"
      borderStyle="round"
      borderColor="inactive"
    >
      {values.map(([value], at) => {
        const isPicked = picked[field].has(value)

        return (
          <Button
            key={`pfopt-${field}-${value}`}
            plain
            onPress={() => {
              if (isPicked) picked[field].delete(value)
              else picked[field].add(value)
              redraw()
            }}
          >
            <Text color={isPicked ? 'claude' : undefined}>{` ${isPicked ? '☑' : '☐'} `}</Text>
            <Text>{`${(lines[at] ?? '').padEnd(inner)}`}</Text>
          </Button>
        )
      })}
      {picked[field].size > 0 && (
        <Button
          key={`pfclear-${field}`}
          plain
          onPress={() => {
            picked[field].clear()
            redraw()
          }}
        >
          <Text dimColor>{'   clear'.padEnd(inner + 3)}</Text>
        </Button>
      )}
    </Box>
  )

  return { row, popup }
}

const matches = (p: TrackedPr) =>
  (['author', 'repo'] as const).every(field => picked[field].size === 0 || picked[field].has(valueOf(p, field)))

export function prsView($: EngineInterface): View {
  return {
    id: 'prs',
    title: 'prs',
    scope: 'session',
    guide: { tool: PRS_TOOL, text: `track the pull requests this session raised on it with ${PRS_TOOL}` },
    onShow: async () => {
      await markActive($)
      void refresh($)
    },
    isAvailable: async () => (await read($, board)).prs.length > 0,
    needs: async () => {
      const b = await read($, board)

      return b.prs.filter(p => needsYou(p, b.viewer)).length
    },
    opensAtStart: async () => (await read($, board)).prs.length > 0,
    clear: async () => {
      const applied = await change($, current => ({ board: emptyBoard(current.sessionId), added: [] }))
      if ('board' in applied) await saveBoard($, PREFIX, SHAPE, applied.board)

      return 'Pull request board cleared.'
    },
    render: async els => {
      const { Box, Text } = els
      const b = await read($, board)
      if (b.prs.length === 0) {
        return (
          <Text dimColor wrap="wrap">
            No pull requests tracked yet. The ones this session opens show here.
          </Text>
        )
      }
      const now = await $.clock.now()
      if (filterFor !== b.sessionId) {
        picked.author.clear()
        picked.repo.clear()
        openFilter = ''
        filterFor = b.sessionId
      }
      // A click outside the pane takes the keyboard back from it, which folds the popup too
      if (wasFocused && !paneFocused()) openFilter = ''
      wasFocused = paneFocused()
      const shown = b.prs.filter(matches)
      const { row, popup } = filters($, els, b.prs)

      return (
        <Box key="prs-view" flexDirection="column">
          {stamp(els, checkedLine(b, now), Boolean(b.error))}
          {row}
          {shown.length > 0 ? (
            prsBox(els, groupsOf(shown), b.viewer)
          ) : (
            <Text key="pnone" dimColor>
              No pull requests match the filter.
            </Text>
          )}
          {popup}
        </Box>
      )
    },
  }
}
