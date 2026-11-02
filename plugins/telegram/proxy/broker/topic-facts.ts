// What the broker needs to know of a topic: where it hangs, whether its agent
// runs and is between turns, and which pid its multiplexer gives that agent.
import { atTurnBoundary } from '../topics/domain/claude-update'
import { sessionOf } from '../topics/domain/agent'
import { sessionNode } from '../topics/domain/session-tree'
import { liveClaudeSessions } from '../topics/claude-sessions'
import type { LiveClaudeSession } from '../topics/claude-sessions'
import { muxes } from '../topics/mux'
import { topics } from '../topics/state'
import { proxyHoldsWork } from '../topics/update-restarts'
import type { TargetFacts } from './domain/relaunch'

export type TopicFactsPorts = {
  /** A harness-locked topic relaunches through its harness, which waits for its own turn boundary. */
  harnessLocked: (topic: string) => boolean
  paneInFlight: (topic: string) => boolean
  square?: string
  sessions?: () => Map<string, LiveClaudeSession>
  now?: () => number
}

export function topicFacts({ harnessLocked, paneInFlight, square, sessions = liveClaudeSessions, now = Date.now }: TopicFactsPorts) {
  function facts(topic: string): TargetFacts | undefined {
    const st = topics.get(topic)
    if (!st) return undefined
    const parent = sessionNode(topic, st.session).parent
    if (topic === square) return { parent, running: false, idle: false }
    if (harnessLocked(topic)) return { parent, running: true, idle: true }
    if (st.agent.state !== 'running') return { parent, running: false, idle: false }
    const claude = st.claudeSessionId ? sessions().get(st.claudeSessionId) : undefined
    const idle = atTurnBoundary(claude?.activity, claude?.activitySince, now()) && !proxyHoldsWork(topic, st, paneInFlight)
    return { parent, running: true, idle }
  }

  function agentPid(topic: string): number | undefined {
    const agent = topics.get(topic)?.agent
    const session = agent ? sessionOf(agent) : undefined
    return session ? muxes.agentPid(session) : undefined
  }

  function callerTopic(ancestry: readonly number[]): string | undefined {
    for (const topic of topics.keys()) {
      const pid = agentPid(topic)
      if (pid !== undefined && ancestry.includes(pid)) return topic
    }
    return undefined
  }

  return { facts, agentPid, callerTopic }
}
