import { world } from './engine'
import type { World } from './engine'

export type Pr = {
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  headRefName: string
  baseRefName: string
  rollup: string
  failing: string[]
  threads: { isResolved: boolean; by: string }[]
  approvals?: string[]
  author?: string
  checks?: Record<string, unknown>[]
}

export const pr = (over: Partial<Pr>): Pr => ({
  title: 'A change',
  state: 'OPEN',
  isDraft: true,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'REVIEW_REQUIRED',
  headRefName: 'feature/x',
  baseRefName: 'main',
  rollup: 'SUCCESS',
  failing: [],
  threads: [],
  ...over,
})

function asGraphql(p: Pr) {
  return {
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    reviewDecision: p.reviewDecision,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    headRefOid: 'abc123',
    author: { login: p.author ?? 'octo' },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: p.rollup,
              contexts: {
                nodes: p.checks ?? [
                  ...p.failing.map(name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' })),
                  p.rollup === 'PENDING'
                    ? { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: null }
                    : { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
              },
            },
          },
        },
      ],
    },
    reviewThreads: {
      nodes: p.threads.map((t, at) => ({
        isResolved: t.isResolved,
        comments: { nodes: [{ author: { login: t.by }, url: `https://github.com/t/${at}` }] },
      })),
    },
    latestReviews: { nodes: (p.approvals ?? []).map(login => ({ author: { login }, state: 'APPROVED' })) },
  }
}

/** A process fake whose gh answers GitHub's GraphQL from `github`, keyed by pull request number. */
export function ghRun(github: Record<number, Pr>, budget?: { remaining: number; resetAt: string }): World['run'] {
  return argv => {
    if (argv[0] !== 'gh') return undefined
    const query = argv[argv.length - 1] ?? ''
    const data: Record<string, unknown> = { viewer: { login: 'octo' }, ...(budget && { rateLimit: budget }) }
    for (const [, alias, number] of query.matchAll(/(p\d+): repository\([^)]*\) \{ pullRequest\(number: (\d+)\)/g)) {
      const found = github[Number(number)]
      data[alias as string] = { pullRequest: found ? asGraphql(found) : null }
    }

    return { exitCode: 0, stdout: JSON.stringify({ data }), stderr: '' }
  }
}

/** A world whose gh answers GitHub's GraphQL from `github`. */
export const gh = (github: Record<number, Pr>, budget?: { remaining: number; resetAt: string }) =>
  world({ run: ghRun(github, budget) })
