import type { EngineInterface } from 'claude-code'

import type { TrackedPr } from '../../../types'
import { cachedFacts } from '../../github/cache'
import { needsOf, needsYou, storedPrs } from '../../views/prs'
import type { Artifact, Status } from '../model'

/** Needs the person by the prs view's rule; someone else's open pull request is otherwise watched. */
function statusOf(p: TrackedPr, viewer: string): Status {
  const f = p.facts
  if (!f) return 'next'
  if (needsYou(p, viewer)) return 'needs'
  if (f.state !== 'OPEN') return 'done'
  const isOwn = !viewer || f.author.toLowerCase() === viewer.toLowerCase()
  if (!isOwn) return 'watching'

  return f.isDraft ? 'flight' : 'waiting'
}

export const artifactIdOf = (p: TrackedPr) => `pr:${p.owner}/${p.repo}#${p.number}`

export type Tracked = { pr: TrackedPr; sessions: string[] }

/** Every pull request some session tracks, with the freshest facts any session cached and who tracks it; no GitHub calls. */
export async function trackedPrs($: EngineInterface, held: Record<string, unknown>): Promise<{ tracked: Tracked[]; viewer: string }> {
  const fresh = await cachedFacts($)
  const tracked = storedPrs(held).map(({ pr, sessions }) => {
    const facts = fresh.facts.get(pr.key) ?? pr.facts

    return { pr: facts ? { ...pr, facts } : pr, sessions }
  })

  return { tracked, viewer: fresh.viewer }
}

export async function readArtifacts($: EngineInterface, held: Record<string, unknown>): Promise<Artifact[]> {
  const { tracked, viewer } = await trackedPrs($, held)

  return tracked.map(({ pr: p, sessions }) => {
    const status = statusOf(p, viewer)
    const note = status === 'needs' ? needsOf(p)[0]?.text : undefined

    return {
      id: artifactIdOf(p),
      title: p.facts?.title ?? `${p.owner}/${p.repo}#${p.number}`,
      url: p.url,
      branch: p.facts?.head ?? '',
      tag: `#${p.number}`,
      status,
      trackedBy: sessions,
      ...(note && { note }),
    }
  })
}
