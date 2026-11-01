// The proxy's topics as the conductor lists them. The state is coarse here:
// whether the topic's agent runs; working and blocked come from hc's events.
import { muxes } from '../topics/mux'
import { currentRoute, topicNames, topics } from '../topics/state'
import type { TopicSummary } from './api'

export function conductorTopics(hidden: (topic: string) => boolean, kindOf: (topic: string) => string): TopicSummary[] {
  const live = muxes.liveSessions()
  return [...topics]
    .filter(([topic]) => !hidden(topic))
    .map(([topic, st]) => {
      const kind = kindOf(topic)
      const route = currentRoute(st)
      return {
        id: topic,
        name: st.name || topicNames.get(topic) || topic,
        kind,
        route: kind === 'claude' ? { provider: route.provider, model: route.model, effort: route.effort } : null,
        state: st.agent.state === 'running' && live.has(st.agent.session)
          ? 'idle'
          : st.agent.state === 'failed' ? 'missing' : 'stopped',
      }
    })
}
