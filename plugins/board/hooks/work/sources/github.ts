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
