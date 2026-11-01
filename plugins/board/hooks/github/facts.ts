import type { CiState, PrFacts, TrackedPr } from '../../types'

// GitHub's answer about a pull request, and the facts the board keeps from it.

const FAILED_RUNS = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

export const PR_FIELDS = `title state isDraft mergeable mergeStateStatus reviewDecision
  headRefName baseRefName headRefOid author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status conclusion startedAt completedAt
      checkSuite { workflowRun { runNumber event workflow { databaseId } } } } ... on StatusContext { context state createdAt } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved comments(last: 50) { nodes { author { login } url } } } }
  latestReviews(first: 20) { nodes { author { login } state } }`

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
export type GqlPr = {
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
export type GqlAnswer = { data?: Record<string, unknown>; errors?: { message: string }[] }

const NOT_CI = new Set(['Graphite / mergeability_check'])

// A run not started yet is the newest of its check
const startOf = (check: GqlCheck) =>
  check.startedAt ?? (check.status === 'COMPLETED' ? check.completedAt : undefined) ?? check.createdAt ?? '\uffff'
const workflowOf = (run: WorkflowRun) => `${run.workflow.databaseId} ${run.event}`

const isFailed = (check: GqlCheck) =>
  check.__typename === 'CheckRun' ? FAILED_RUNS.includes(check.conclusion ?? '') : check.state === 'FAILURE' || check.state === 'ERROR'
const runKeyOf = (check: GqlCheck) => {
  const run = check.checkSuite?.workflowRun

  return run ? `${workflowOf(run)} ${run.runNumber}` : undefined
}

/**
 * CI as GitHub's checks list shows it, by the latest run of each workflow and the latest run of each check. The
 * commit's rollup state counts every run, so a run a newer one replaced keeps it failed: a workflow run its
 * concurrency group cancelled leaves cancelled jobs the newer run has not reached yet.
 *
 * On a draft, a job that starts after its run skipped other jobs and fails with nothing else in its run failing is
 * a gate holding CI until the pull request is ready, so CI reads skipped. A job that fails first and has the jobs after
 * it skipped is a real failure.
 */
function ciOf(rollup: GqlPr['commits']['nodes'][number]['commit']['statusCheckRollup'], isDraft: boolean) {
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
  const isGate = (check: GqlCheck) => {
    const run = runKeyOf(check)
    if (!isDraft || !run || check.__typename !== 'CheckRun') return false
    const inRun = checks.map(([, one]) => one).filter(one => one !== check && runKeyOf(one) === run)
    const isSkippedBefore = (one: GqlCheck) => one.conclusion === 'SKIPPED' && (one.completedAt ?? '') <= (check.startedAt ?? '')

    return inRun.some(isSkippedBefore) && !inRun.some(isFailed)
  }
  const failed = checks.filter(([, check]) => isFailed(check))
  const failing = failed.filter(([, check]) => !isGate(check)).map(([name]) => name)
  const isRunning = checks.some(([, check]) =>
    check.__typename === 'CheckRun' ? check.status !== 'COMPLETED' : check.state === 'PENDING' || check.state === 'EXPECTED',
  )
  const ci: CiState = failing.length > 0 ? 'fail' : isRunning ? 'pending' : failed.length > 0 ? 'skipped' : 'pass'

  return { ci, failing }
}

/**
 * An open thread whose last comment is someone else's waits on the pull request's author. On someone else's pull
 * request it waits on the viewer only when they commented in it; the rest are between its author and other reviewers.
 */
export function factsOf(pr: GqlPr, viewer: string): PrFacts {
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
    ...ciOf(pr.commits.nodes[0]?.commit.statusCheckRollup ?? null, pr.isDraft),
    author,
    head: pr.headRefName,
    base: pr.baseRefName,
    headSha: pr.headRefOid,
    waiting: waiting.length,
    ...(waiting[0] && { waitingUrl: waiting[0].url }),
  }
}

export const isConflicted = (f: PrFacts) => f.mergeable === 'CONFLICTING' || f.mergeState === 'DIRTY'

/**
 * GitHub's review decision, or in a repo that requires no review, where GitHub gives none, the one the latest reviews
 * make. Read here rather than stored, since sessions of every version share the facts they fetch.
 */
export function reviewOf(f: PrFacts): string {
  if (f.review) return f.review
  if (f.changesRequestedBy.length > 0) return 'CHANGES_REQUESTED'

  return f.approvedBy.length > 0 ? 'APPROVED' : ''
}

export function transitions(p: TrackedPr, now: PrFacts): string[] {
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
