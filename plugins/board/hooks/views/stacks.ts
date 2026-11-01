import type { TrackedPr } from '../../types'

/** A group of pull requests: `chains` holds each git stack bottom first, a lone pull request as a chain of one. */
export type Stack = { title: string; prs: TrackedPr[]; chains: TrackedPr[][] }

const repoOf = (p: TrackedPr) => `${p.owner}/${p.repo}`.toLowerCase()
const branchKey = (p: TrackedPr, branch: string) => `${repoOf(p)}:${branch}`

/** The tracked pull request whose head branch this one is based on. */
export function belowOf(p: TrackedPr, prs: readonly TrackedPr[]): TrackedPr | undefined {
  if (!p.facts) return undefined
  const base = branchKey(p, p.facts.base)

  return prs.find(other => other !== p && other.facts && branchKey(other, other.facts.head) === base)
}

/**
 * Each git stack as one run from its bottom up, in the order its bottom was tracked, then the lone pull requests. A
 * branch that two layers are based on keeps both above it in the one run.
 */
export function chainsOf(members: TrackedPr[]): TrackedPr[][] {
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

/** Headed stacks first, then the pull requests in none, under "Other" once anything is headed. */
export function groupsOf(prs: readonly TrackedPr[]): Stack[] {
  const stacks = stacksOf(prs)
  const headed = stacks
    .filter(stack => stack.title !== '' || stack.prs.length > 1)
    .map(stack => ({ ...stack, title: stack.title || 'Stack' }))
  const loose = stacks.filter(stack => stack.title === '' && stack.prs.length === 1).flatMap(stack => stack.prs)
  if (loose.length === 0) return headed

  return [...headed, { title: headed.length > 0 ? 'Other' : '', prs: loose, chains: loose.map(p => [p]) }]
}
