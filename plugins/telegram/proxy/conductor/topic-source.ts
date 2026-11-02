// The proxy's topics as the conductor lists them. A topic on hc reports its
// agent's state, title, screen and activity live; any other topic only what
// the proxy's lifecycle knows.
import type { TopicSelection } from '../topics/domain/topic-selection'
import { currentRoute, topicNames, topics } from '../topics/state'
import type { TopicSummary } from './api'
import { projectOf, sessionNode, topicRole } from '../topics/domain/session-tree'
import { agentState } from './domain/agent-state'
import type { HcWatch } from './hc-watch'
import type { ScreenView } from './wire'
import type { Activity } from './domain/activity'

export type HcTopics = { topics: Pick<TopicSelection, 'has'>; watch: HcWatch }

/** The hc terminal of a topic whose session runs there now. */
export function hcTerminal(topic: string, hc: HcTopics | undefined) {
  const st = topics.get(topic)
  if (!hc?.topics.has(topic) || st?.agent.state !== 'running') return undefined
  return hc.watch.terminal(st.agent.session)
}

export function conductorTopics(
  hidden: (topic: string) => boolean,
  kindOf: (topic: string) => string,
  hc?: HcTopics,
  activity?: (topic: string) => Activity | undefined,
): TopicSummary[] {
  return [...topics]
    .filter(([topic]) => !hidden(topic))
    .map(([topic, st]) => {
      const kind = kindOf(topic)
      const route = currentRoute(st)
      const terminal = hcTerminal(topic, hc)
      const onHc = hc?.topics.has(topic) ? { core: hc.watch.connected(), terminal } : undefined
      const node = sessionNode(topic, st.session)
      const role = topicRole(topic)
      return {
        role,
        projectId: projectOf(role, topic, node.parent),
        parentId: node.parent,
        spawnedBy: node.spawnedBy,
        spawnedAt: node.spawnedAt,
        id: topic,
        name: st.name || topicNames.get(topic) || topic,
        kind,
        title: terminal?.title ?? null,
        route: kind === 'claude' ? { provider: route.provider, model: route.model, effort: route.effort } : null,
        state: agentState(st.agent.state, onHc),
        archivedAt: st.archivedAt ?? null,
        activity: activity?.(topic) ?? null,
      }
    })
}

/** What a topic's session says it is blocked on, when it is. */
export const conductorBlocked = (topic: string, hc: HcTopics) => hcTerminal(topic, hc)?.blocked

/** A topic's screen as text, read from its hc terminal; undefined for a topic with none. */
export async function conductorScreenText(topic: string, hc: HcTopics): Promise<string | undefined> {
  const terminal = hcTerminal(topic, hc)
  return terminal ? hc.watch.read(terminal.address) : undefined
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
