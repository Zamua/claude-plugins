// Turns what the topic list says into news: when a topic's state, title, name
// or route changes, or a topic appears, the store records a topic event, which
// the stream sends and replays. It also knows since when each state has held.
import type { TopicSummary } from './api'
import type { ConductorStore } from './sqlite-store'

export function topicTracker(ports: {
  topics: () => TopicSummary[]
  store: Pick<ConductorStore, 'topicChanged'>
  /** Anything else about a topic whose change is news (the app's pin and mute). */
  extra?: (topic: string) => unknown
  now?: () => number
}) {
  const now = ports.now ?? Date.now
  const seen = new Map<string, { key: string; state: TopicSummary['state']; since: string | null }>()
  let started = false

  /** Compares every topic with what was seen last; the first look only records. */
  function refresh(): void {
    for (const t of ports.topics()) {
      const key = JSON.stringify([t.name, t.kind, t.title, t.route, t.state, ports.extra?.(t.id)])
      const before = seen.get(t.id)
      if (before?.key === key) continue
      const since = before?.state === t.state ? before.since : started ? new Date(now()).toISOString() : null
      seen.set(t.id, { key, state: t.state, since })
      if (started) ports.store.topicChanged(t.id)
    }
    started = true
  }

  return { refresh, since: (topic: string) => seen.get(topic)?.since ?? null }
}
