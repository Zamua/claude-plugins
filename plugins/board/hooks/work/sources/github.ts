import type { EngineInterface } from 'claude-code'

import type { TrackedPr } from '../../../types'
import { cachedFacts, needsOf, storedPrs } from '../../views/prs'
import type { Artifact, Status } from '../model'

function statusOf(p: TrackedPr): Status {
  if (needsOf(p).length > 0) return 'needs'
  const f = p.facts
  if (!f) return 'next'
  if (f.state !== 'OPEN') return 'done'

  return f.isDraft ? 'flight' : 'waiting'
}

/** Every pull request some session tracks, with the freshest facts any session cached; no GitHub calls. */
export async function readArtifacts($: EngineInterface, held: Record<string, unknown>): Promise<Artifact[]> {
  const fresh = await cachedFacts($)

  return storedPrs(held).map(stored => {
    const facts = fresh.get(stored.key) ?? stored.facts
    const p = facts ? { ...stored, facts } : stored
    const note = needsOf(p)[0]?.text

    return {
      id: `pr:${p.owner}/${p.repo}#${p.number}`,
      title: p.facts?.title ?? `${p.owner}/${p.repo}#${p.number}`,
      url: p.url,
      branch: p.facts?.head ?? '',
      tag: `#${p.number}`,
      status: statusOf(p),
      ...(note && { note }),
    }
  })
}
