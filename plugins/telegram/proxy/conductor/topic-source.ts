// The proxy's topics as the conductor lists them. A topic on hc reports its
// agent's state, title and screen live from its terminal; any other topic only
// what the proxy's lifecycle knows.
import { currentRoute, topicNames, topics } from '../topics/state'
import type { TopicSummary } from './api'
import { agentState } from './domain/agent-state'
import type { HcWatch } from './hc-watch'
import type { ScreenView } from './wire'

export type HcTopics = { topics: ReadonlySet<string>; watch: HcWatch }

function hcTerminal(topic: string, hc: HcTopics | undefined) {
  const st = topics.get(topic)
  if (!hc?.topics.has(topic) || st?.agent.state !== 'running') return undefined
  return hc.watch.terminal(st.agent.session)
}

export function conductorTopics(hidden: (topic: string) => boolean, kindOf: (topic: string) => string, hc?: HcTopics): TopicSummary[] {
  return [...topics]
    .filter(([topic]) => !hidden(topic))
    .map(([topic, st]) => {
      const kind = kindOf(topic)
      const route = currentRoute(st)
      const terminal = hcTerminal(topic, hc)
      const onHc = hc?.topics.has(topic) ? { core: hc.watch.connected(), terminal } : undefined
      return {
        id: topic,
        name: st.name || topicNames.get(topic) || topic,
        kind,
        title: terminal?.title ?? null,
        route: kind === 'claude' ? { provider: route.provider, model: route.model, effort: route.effort } : null,
        state: agentState(st.agent.state, onHc),
      }
    })
}

/** A topic's screen, read from its hc terminal; undefined for a topic with none to show. */
export async function conductorScreen(topic: string, hc: HcTopics): Promise<ScreenView | undefined> {
  const terminal = hcTerminal(topic, hc)
  if (!terminal) return undefined
  const text = await hc.watch.read(terminal.address)
  if (text === undefined) return undefined
  const rows = text.split('\n')
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop()
  return { topic, rows, cols: terminal.cols ?? 0, working: terminal.status === 'working' }
}
