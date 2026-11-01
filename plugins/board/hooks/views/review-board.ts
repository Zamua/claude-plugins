// A pr-review-board review's board.json and the rules read off it; no drawing and no `$`.
import type { SectionSpec } from '../kit'

export type Pr = { pr: string; number: number; url?: string; title?: string; other_open_threads?: number }
export type CommentFile = { url?: string; label?: string; kind?: string }
export type Comment = {
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
export type ReportSection = { id?: string; title?: string; markdown?: string }
type NamedStack = { id: string; title?: string; prs: string[]; verdict?: string; risk?: string; blast_radius?: string }
export type Board = {
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
/** The poller's `github.json` beside the board. */
export type Facts = { prs?: Record<string, { threads?: Thread[]; state?: string; approved?: boolean }> }
export type Stack = Omit<NamedStack, 'prs'> & { title: string; prs: Pr[] }

export const SEVERITIES: readonly SectionSpec[] = [
  { id: 'live', title: 'Live on merge', color: 'error' },
  { id: 'high', title: 'High', color: 'error' },
  { id: 'medium', title: 'Medium', color: 'warning' },
  { id: 'low-medium', title: 'Low to medium', color: 'suggestion' },
  { id: 'low', title: 'Low', color: 'permission' },
  { id: 'question', title: 'Questions', color: 'inactive' },
]
// A posted comment waits on its author until the review marks it addressed
export const FOLLOW_UPS: readonly (SectionSpec & { holds: (c: Comment) => boolean })[] = [
  { id: 'unaddressed', title: 'Unaddressed', color: 'warning', holds: c => !c.addressed },
  { id: 'addressed', title: 'Addressed', color: 'success', holds: c => c.addressed === true },
]

export const commentsOf = (b: Board) => (Array.isArray(b.comments) ? b.comments : [])
export const isPickable = (c: Comment) => !c.status || c.status === 'proposed' || c.status === 'approved'
export const severityOf = (c: Comment) => SEVERITIES.find(s => s.id === c.severity) ?? (SEVERITIES[SEVERITIES.length - 1] as SectionSpec)

export function prsFromState(prs: unknown): Pr[] {
  return (Array.isArray(prs) ? (prs as string[]) : []).map(pr => {
    const [repo, number] = pr.split('#')
    return { pr, number: Number(number), url: `https://github.com/${repo}/pull/${number}` }
  })
}

/** A comment names its pull request as `owner/repo#N`, or by bare number in a single-repo review. */
export function prOf(c: Comment, prs: readonly Pr[]): { number: number; url?: string } {
  const found = prs.find(p => (typeof c.pr === 'string' ? p.pr === c.pr : p.number === c.pr))
  const number = found ? found.number : typeof c.pr === 'string' ? Number(c.pr.split('#')[1]) : c.pr

  return { number, ...(found?.url && { url: found.url }) }
}

/**
 * The board with the review threads the operator started that it did not post, from the poller's `github.json`,
 * counted while unresolved and unanswered.
 */
export function withFacts(raw: Board, f: Facts | undefined): Board {
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
export function stacksOf(b: Board, prs: Pr[]): Stack[] {
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
export function stackOf(c: Comment, prs: readonly Pr[], stacks: readonly Stack[]) {
  const found = prs.find(p => (typeof c.pr === 'string' ? p.pr === c.pr : p.number === c.pr))
  const stack = found && stacks.find(s => s.prs.includes(found))

  return stack ? stack.id : undefined
}

/** Review threads on these pull requests that wait on the author and that the board did not post. */
export const otherOpen = (prs: readonly Pr[]) =>
  prs.reduce((sum, p) => sum + (Number.isInteger(p.other_open_threads) ? (p.other_open_threads as number) : 0), 0)

/** Where a review stands, most in need of the person first. */
export const REVIEW_STATES = ['pick', 'waiting', 'reviewing', 'posted', 'approved', 'finished'] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

/** One review as the rollup lists it. */
export type ReviewDigest = {
  key: string
  title: string
  /** The agent running it, by its Harness id. */
  agent: string
  /** Each pull request, with its state as the poller last read it. */
  prs: { pr: string; number: number; url: string; title?: string; state?: string }[]
  updatedAt: number
  state: ReviewState
  /** Comments waiting for the person to pick. */
  toPick: number
  /** On its open pull requests, its posted comments not addressed and the operator's other threads nobody answered. */
  unanswered: number
  openPrs: number
}

/**
 * Comments to pick come first. Once every pull request merged or closed it is finished; before that, a posted comment
 * its author has not addressed or an unanswered thread waits on the author, and every open one approved is approved.
 */
function reviewStateOf(toPick: number, posted: Comment[], unanswered: number, openPrs: number, isApproved: boolean): ReviewState {
  if (toPick > 0) return 'pick'
  if (openPrs === 0) return 'finished'
  if (unanswered > 0) return 'waiting'
  if (isApproved) return 'approved'

  return posted.length > 0 ? 'posted' : 'reviewing'
}

/** A review from its board and the poller's facts; a board not written yet leaves the pull requests the poller lists. */
export function digestOf(key: string, slug: string, agent: string, listed: Pr[], b: Board | undefined, f: Facts | undefined): ReviewDigest {
  const prs = b && Array.isArray(b.prs) ? b.prs : listed
  const facts = f?.prs ?? {}
  const comments = b ? commentsOf(b) : []
  // A pull request the poller has not described yet counts as open
  const open = prs.filter(p => (facts[p.pr]?.state ?? 'OPEN') === 'OPEN')
  const isOnOpen = (c: Comment) => open.some(p => (typeof c.pr === 'string' ? p.pr === c.pr : p.number === c.pr))
  const posted = comments.filter(c => c.status === 'posted' && isOnOpen(c))
  const postedUrls = new Set(comments.map(c => c.posted_url).filter(Boolean))
  const others = open
    .flatMap(p => (Array.isArray(facts[p.pr]?.threads) ? (facts[p.pr]?.threads as Thread[]) : []))
    .filter(t => !postedUrls.has(t.url) && !t.resolved && !t.replied)
  const unanswered = posted.filter(c => !c.addressed).length + others.length
  const isApproved = open.length > 0 && open.every(p => facts[p.pr]?.approved === true)
  const toPick = comments.filter(isPickable).length

  return {
    key,
    title: b?.title || slug,
    agent,
    prs: prs.map(p => ({
      pr: p.pr,
      number: p.number,
      url: p.url || `https://github.com/${p.pr.split('#')[0]}/pull/${p.number}`,
      ...(p.title && { title: p.title }),
      ...(facts[p.pr]?.state && { state: facts[p.pr]?.state }),
    })),
    updatedAt: Date.parse(b?.updated_at ?? ''),
    state: reviewStateOf(toPick, posted, unanswered, open.length, isApproved),
    toPick,
    unanswered,
    openPrs: open.length,
  }
}
