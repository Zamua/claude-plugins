import type { EngineInterface } from 'claude-code'

import type { TrackedPr } from '../../../types'
import { cachedFacts, needsOf, storedPrs } from '../../views/prs'
import type { Artifact, Status } from '../model'

/**
 * The person's own pull request needs them when the prs view says so. Someone else's, which a session only watches,
 * needs them only for a review thread waiting on them.
 */
function statusOf(p: TrackedPr, viewer: string): Status {
  const f = p.facts
  if (!f) return 'next'
  const isOwn = !viewer || f.author.toLowerCase() === viewer.toLowerCase()
  if (isOwn ? needsOf(p).length > 0 : f.state === 'OPEN' && f.waiting > 0) return 'needs'
  if (f.state !== 'OPEN') return 'done'
  if (!isOwn) return 'watching'

  return f.isDraft ? 'flight' : 'waiting'
}

/** Every pull request some session tracks, with the freshest facts any session cached; no GitHub calls. */
export async function readArtifacts($: EngineInterface, held: Record<string, unknown>): Promise<Artifact[]> {
  const fresh = await cachedFacts($)

  return storedPrs(held).map(stored => {
    const facts = fresh.facts.get(stored.key) ?? stored.facts
    const p = facts ? { ...stored, facts } : stored
    const status = statusOf(p, fresh.viewer)
    const note = status === 'needs' ? needsOf(p)[0]?.text : undefined

    return {
      id: `pr:${p.owner}/${p.repo}#${p.number}`,
      title: p.facts?.title ?? `${p.owner}/${p.repo}#${p.number}`,
      url: p.url,
      branch: p.facts?.head ?? '',
      tag: `#${p.number}`,
      status,
      ...(note && { note }),
    }
  })
}
