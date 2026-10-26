import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, On } from 'claude-code'

import type { CiState, PrBoard, PrFacts, TrackedPr } from '../../types'
import { ago, prRow } from '../kit'
import type { Els, View } from '../kit'
import { showView } from '../pane'
import { legacyValue, loadBoard, saveBoard } from '../store'

export const PRS_TOOL = 'mcp__board__prs'

const REFRESH_MS = 60_000

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
const CI_WORDS: Record<CiState, string> = { pass: 'passing', fail: 'failing', pending: 'running', none: 'not run' }
const FAILED_RUNS = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

const PR_FIELDS = `title state isDraft mergeable mergeStateStatus reviewDecision
  headRefName baseRefName headRefOid author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { author { login } url } } } }
  latestReviews(first: 20) { nodes { author { login } state } }`

type Ref = Pick<TrackedPr, 'key' | 'owner' | 'repo' | 'number' | 'url'>
type Entry = { pr: string; note?: string; stack?: string }
type Input = { add?: Entry[]; update?: Entry[]; remove?: string[] }
type Applied = { board: PrBoard; added: string[] } | { error: string }
type Stack = { title: string; prs: TrackedPr[] }
type Need = { text: string; href?: string }
type Word = { text: string; color?: Color; isDim?: boolean }

type Login = { login: string } | null
type GqlCheck = {
  __typename: string
  name?: string
  status?: string
  conclusion?: string | null
  context?: string
  state?: string
}
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

function ciOf(rollup: GqlPr['commits']['nodes'][number]['commit']['statusCheckRollup']) {
  if (!rollup) return { ci: 'none' as CiState, failing: [] }
  const failing = rollup.contexts.nodes
    .filter(check =>
      check.__typename === 'CheckRun'
        ? FAILED_RUNS.includes(check.conclusion ?? '')
        : check.state === 'FAILURE' || check.state === 'ERROR',
    )
    .map(check => check.name ?? check.context ?? 'a check')
  const ci: CiState =
    rollup.state === 'SUCCESS'
      ? 'pass'
      : rollup.state === 'FAILURE' || rollup.state === 'ERROR'
        ? 'fail'
        : 'pending'

  return { ci, failing }
}

function factsOf(pr: GqlPr, viewer: string): PrFacts {
  const waiting = pr.reviewThreads.nodes
    .filter(thread => !thread.isResolved)
    .map(thread => thread.comments.nodes[0])
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
    author: pr.author?.login ?? '',
    head: pr.headRefName,
    base: pr.baseRefName,
    headSha: pr.headRefOid,
    waiting: waiting.length,
    ...(waiting[0] && { waitingUrl: waiting[0].url }),
  }
}

const isConflicted = (f: PrFacts) => f.mergeable === 'CONFLICTING' || f.mergeState === 'DIRTY'

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
  if (was.review !== now.review && now.review === 'APPROVED') out.push(`${name} approved`)
  if (was.review !== now.review && now.review === 'CHANGES_REQUESTED') {
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

function ordered(members: TrackedPr[]): TrackedPr[] {
  const depth = (p: TrackedPr, seen: Set<TrackedPr>): number => {
    const below = belowOf(p, members)
    if (!below || seen.has(below)) return 0
    seen.add(p)

    return 1 + depth(below, seen)
  }

  return members
    .map((p, at) => ({ p, at, depth: depth(p, new Set()) }))
    .sort((a, b) => a.depth - b.depth || a.at - b.at)
    .map(one => one.p)
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

  return [...groups.values()].map(members => ({
    title: members.find(p => p.stack)?.stack ?? '',
    prs: ordered(members),
  }))
}

/** What a pull request waits on the person for, one line each; none once it merged or closed. */
function needsOf(p: TrackedPr): Need[] {
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
  if (f.review === 'CHANGES_REQUESTED') {
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

const needsYou = (p: TrackedPr) => needsOf(p).length > 0

function stateOf(p: TrackedPr): Word {
  const f = p.facts
  if (!f) return { text: '', isDim: true }
  if (f.state === 'MERGED') return { text: 'merged', color: 'success' }
  if (f.state === 'CLOSED') return { text: 'closed', isDim: true }

  return f.isDraft ? { text: 'draft', isDim: true } : { text: 'ready', color: 'suggestion' }
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

  return [...headed, { title: headed.length > 0 ? 'Other' : '', prs: loose }]
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

async function fetchFacts($: EngineInterface, b: PrBoard) {
  const parts = b.prs.map(
    (p, at) =>
      `p${at}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) { pullRequest(number: ${p.number}) { ...F } }`,
  )
  const query = `query { viewer { login } ${parts.join(' ')} } fragment F on PullRequest { ${PR_FIELDS} }`
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
  const viewer = (data.viewer as { login?: string } | undefined)?.login ?? b.viewer
  const found = new Map(
    b.prs.map((p, at) => {
      const node = data[`p${at}`] as { pullRequest: GqlPr | null } | null | undefined
      return [p.key, node?.pullRequest ? factsOf(node.pullRequest, viewer) : undefined] as const
    }),
  )

  return { viewer, found }
}

async function refreshNow($: EngineInterface) {
  await syncBoard($)
  const b = await read($, board)
  if (b.prs.length === 0) return
  const now = await $.clock.now()
  try {
    const { viewer, found } = await fetchFacts($, b)
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

      return { ...current, prs, viewer, checkedAt: now, error: '' }
    })
    for (const text of toasts) $.ui.toast(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, board, current => (current.sessionId === b.sessionId ? { ...current, error: message } : current))
  }
  await saveBoard($, PREFIX, SHAPE, await read($, board))
}

let queue: Promise<void> = Promise.resolve()

/** Refreshes run one at a time, each reading the board as it stands when it starts. */
function refresh($: EngineInterface): Promise<void> {
  queue = queue.then(() => refreshNow($)).catch(() => undefined)

  return queue
}

/**
 * One line per pull request: a check once approved, a mark while it needs the person, its number, a dot for CI and
 * mergeability, its state and its title. A layer based on something other than the row above names its base.
 */
function prRows(els: Els, group: Stack, tree: boolean) {
  const { Box, Text } = els

  return group.prs.map((p, at) => {
    const below = belowOf(p, group.prs)
    const named = below && group.prs[at - 1] !== below ? below : undefined
    const state = stateOf(p)

    return prRow(els, {
      id: p.key,
      number: p.number,
      url: p.url,
      ...(tree && { tree: at === group.prs.length - 1 ? ('last' as const) : ('mid' as const) }),
      ...(p.facts?.review === 'APPROVED' && { mark: { glyph: '✓', color: 'success' } }),
      isFlagged: needsYou(p),
      dot: healthOf(p),
      columns: [
        <Box key={`state-${p.key}`} width={6} flexShrink={0}>
          <Text color={state.color} dimColor={state.isDim}>
            {state.text}
          </Text>
        </Box>,
      ],
      ...(named && { on: named.number }),
      title: p.facts?.title ?? `${p.owner}/${p.repo}`,
    })
  })
}

function prsBox(els: Els, groups: Stack[]) {
  const { Box, Text } = els
  const several = groups.length > 1

  return (
    <Box key="prs" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
      {groups.map((group, at) => {
        const landed = group.prs.every(p => p.facts?.state === 'MERGED')

        return (
          <Box key={`group-${at}`} flexDirection="column" marginTop={at > 0 ? 1 : 0}>
            {group.title !== '' && (
              <Box flexDirection="row" columnGap={1}>
                <Text bold>{group.title}</Text>
                {landed && <Text color="success">merged</Text>}
              </Box>
            )}
            {prRows(els, group, several)}
          </Box>
        )
      })}
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
  $.clock.every(REFRESH_MS, async () => {
    const b = await read($, board)
    if (b.prs.some(p => !p.facts || p.facts.state === 'OPEN')) await refresh($)
  })
}

export async function prsSync($: EngineInterface) {
  await syncBoard($)
}

export function prsView($: EngineInterface): View {
  return {
    id: 'prs',
    title: 'prs',
    scope: 'session',
    guide: { tool: PRS_TOOL, text: `track the pull requests this session raised on it with ${PRS_TOOL}` },
    onShow: async () => void refresh($),
    isAvailable: async () => (await read($, board)).prs.length > 0,
    needs: async () => (await read($, board)).prs.filter(needsYou).length,
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

      return (
        <Box key="prs-view" flexDirection="column">
          <Box key="checked" flexDirection="row" justifyContent="flex-end" paddingX={1}>
            <Text color={b.error ? 'error' : undefined} dimColor={!b.error} wrap="wrap">
              {checkedLine(b, now)}
            </Text>
          </Box>
          {prsBox(els, groupsOf(b.prs))}
        </Box>
      )
    },
  }
}
