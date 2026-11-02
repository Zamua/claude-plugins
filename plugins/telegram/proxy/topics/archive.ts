// Archive, restore, rename, reparent and hand over topics from the proxy's own side
// (the loopback API and topics-admin), each idempotent. Archiving stops the session and keeps
// its conversation id and transcript; restoring only clears the flag, so the
// next message resumes the same conversation.
import { notAProject } from './domain/archive'
import { ownerRefusal } from './domain/lifecycle-owner'
import type { LifecycleOwner } from './domain/lifecycle-owner'
import { ROOT, reparentRefusal, sessionNode, topicRole } from './domain/session-tree'
import type { ArchiveResult } from './domain/archive'
import { currentRoute, topics } from './state'
import type { TopicState } from './state'

export type TopicArchivePorts = {
  killSession: (st: TopicState, topic: string) => boolean
  save: () => void
  rename: (topic: string, name: string) => Promise<void>
  harnessLocked: (topic: string) => boolean
  /** The background job holding the topic's conversation, if one does. */
  parkedJob: (topic: string) => string | undefined
  square?: string
  now?: () => Date
  log: (line: string) => void
}

export function createTopicArchive({ killSession, save, rename, harnessLocked, parkedJob, square, now = () => new Date(), log }: TopicArchivePorts) {
  const refusal = (topic: string) => notAProject(topic, topics.has(topic), square)

  function archive(list: readonly string[]): ArchiveResult[] {
    const results = [...new Set(list)].map((topic): ArchiveResult => {
      const refused = refusal(topic)
      if (refused) return refused
      const st = topics.get(topic) as TopicState
      if (st.archivedAt) return { topic, outcome: 'already_archived' }
      st.archivedAt = now().toISOString()
      const wasLive = killSession(st, topic)
      const job = parkedJob(topic)
      log(`topic ${topic} "${st.name || topic}" archived${wasLive ? ', its session stopped' : ''}${job ? `; its conversation runs on as background job ${job}` : ''}`)
      return { topic, outcome: 'archived' }
    })
    if (results.some(r => r.outcome === 'archived')) save()
    return results
  }

  function restore(list: readonly string[]): ArchiveResult[] {
    const results = [...new Set(list)].map((topic): ArchiveResult => {
      const refused = refusal(topic)
      if (refused) return refused
      const st = topics.get(topic) as TopicState
      if (!st.archivedAt) return { topic, outcome: 'not_archived' }
      st.archivedAt = undefined
      log(`topic ${topic} "${st.name || topic}" restored; its next message resumes it`)
      return { topic, outcome: 'restored' }
    })
    if (results.some(r => r.outcome === 'restored')) save()
    return results
  }

  async function renameTopic(topic: string, name: string): Promise<ArchiveResult> {
    const refused = refusal(topic)
    if (refused) return refused
    if ((topics.get(topic) as TopicState).name === name) return { topic, outcome: 'unchanged' }
    await rename(topic, name)
    return { topic, outcome: 'renamed' }
  }

  const parentOf = (topic: string) => sessionNode(topic, topics.get(topic)?.session).parent

  /** Hangs a topic under a project as its worker, or under the root as a project again. */
  function reparent(topic: string, parent: string): ArchiveResult {
    const refused = refusal(topic)
    if (refused) return refused
    if (square && parent === square) return { topic, outcome: 'refused', reason: 'the square is not a project' }
    const st = topics.get(topic) as TopicState
    if (parentOf(topic) === parent) return { topic, outcome: 'unchanged' }
    const why = reparentRefusal(
      topic,
      parent,
      t => (topics.has(t) ? topicRole(t, topics.get(t)?.session) : undefined),
      t => [...topics.keys()].some(other => other !== t && parentOf(other) === t),
    )
    if (why) return { topic, outcome: 'refused', reason: why }
    st.session = { parent, spawnedBy: st.session?.spawnedBy ?? null, spawnedAt: st.session?.spawnedAt ?? null }
    save()
    log(`topic ${topic} "${st.name || topic}" now hangs under ${parent}${parent === ROOT ? ' as a project' : ' as its worker'}`)
    return { topic, outcome: 'reparented' }
  }

  /**
   * Hands topics to the Crook backend or back. Going to crook stops the proxy's own
   * session first, since a crook topic's session is never stopped from here. Coming
   * back flips the field only: the backend stops its session before asking.
   */
  function migrate(list: readonly string[], owner: LifecycleOwner): ArchiveResult[] {
    const results = [...new Set(list)].map((topic): ArchiveResult => {
      const st = topics.get(topic)
      if (!st) return { topic, outcome: 'unknown' }
      if ((st.lifecycleOwner ?? 'proxy') === owner) return { topic, outcome: 'unchanged' }
      const why = ownerRefusal(owner, {
        square: !!square && topic === square,
        harnessLocked: harnessLocked(topic),
        provider: currentRoute(st).provider,
        conversation: !!st.claudeSessionId,
      })
      if (why) return { topic, outcome: 'refused', reason: why }
      const job = owner === 'crook' ? parkedJob(topic) : undefined
      if (job) return { topic, outcome: 'refused', reason: `its conversation runs as background job ${job}; stop it first (claude stop ${job})` }
      const wasLive = owner === 'crook' && killSession(st, topic)
      st.lifecycleOwner = owner
      log(`topic ${topic} "${st.name || topic}" now run by ${owner === 'crook' ? 'the Crook backend' : 'the proxy'}${wasLive ? ', the proxy\'s session stopped' : ''}`)
      return { topic, outcome: 'migrated' }
    })
    if (results.some(r => r.outcome === 'migrated')) save()
    return results
  }

  return { archive, restore, rename: renameTopic, reparent, migrate }
}

export type TopicArchive = ReturnType<typeof createTopicArchive>
