// Archive, restore and rename projects from the proxy's own side (the loopback
// API and topics-admin), each idempotent. Archiving stops the session and keeps
// its conversation id and transcript; restoring only clears the flag, so the
// next message resumes the same conversation.
import { notAProject } from './domain/archive'
import type { ArchiveResult } from './domain/archive'
import { topics } from './state'
import type { TopicState } from './state'

export type TopicArchivePorts = {
  killSession: (st: TopicState, topic: string) => boolean
  save: () => void
  rename: (topic: string, name: string) => Promise<void>
  square?: string
  now?: () => Date
  log: (line: string) => void
}

export function createTopicArchive({ killSession, save, rename, square, now = () => new Date(), log }: TopicArchivePorts) {
  const refusal = (topic: string) => notAProject(topic, topics.has(topic), square)

  function archive(list: readonly string[]): ArchiveResult[] {
    const results = [...new Set(list)].map((topic): ArchiveResult => {
      const refused = refusal(topic)
      if (refused) return refused
      const st = topics.get(topic) as TopicState
      if (st.archivedAt) return { topic, outcome: 'already_archived' }
      st.archivedAt = now().toISOString()
      const wasLive = killSession(st, topic)
      log(`topic ${topic} "${st.name || topic}" archived${wasLive ? ', its session stopped' : ''}`)
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

  return { archive, restore, rename: renameTopic }
}

export type TopicArchive = ReturnType<typeof createTopicArchive>
