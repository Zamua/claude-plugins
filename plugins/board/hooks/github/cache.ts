import type { EngineInterface } from 'claude-code'

import type { PrFacts, TrackedPr } from '../../types'
import { messageOf, span } from '../kit'
import { factsOf, PR_FIELDS } from './facts'
import type { GqlAnswer, GqlPr } from './facts'

// GitHub times out with HTTP 504 on one query covering a few dozen pull requests
const BATCH = 8
// Every session reads and writes what it fetched here, so a pull request several sessions track is asked about once
const CACHE_PATH = '.cache/board/github.json'
const FRESH_MS = 3 * 60_000
const KEEP_MS = 24 * 3600_000
// GitHub allows 5000 GraphQL points an hour across everything signed in as the person, agents and pollers included
const BUDGET_FLOOR = 1000
const PAUSE_MS = 10 * 60_000

type Cached = { facts?: PrFacts; at: number; v?: number }

// Raised when facts are derived from GitHub differently: an entry a session on an older board wrote is fetched again
// rather than shown
const FACTS_VERSION = 4
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
export async function fetchFacts($: EngineInterface, b: { prs: readonly TrackedPr[]; viewer: string }, mayAsk = true) {
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
