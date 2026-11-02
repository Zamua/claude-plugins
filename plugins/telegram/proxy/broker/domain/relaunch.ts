// Who may relaunch which topics through the broker, and what happens to each.
import { descendsFrom } from '../../topics/domain/session-tree'

export type RelaunchOutcome = 'applied' | 'queued' | 'no_agent' | 'refused'

export type TargetFacts = {
  /** Where the topic hangs in the session tree. */
  parent: string | null
  /** Its agent is running now. */
  running: boolean
  /** Its agent is between turns and the proxy holds no work for it. */
  idle: boolean
}

export type TargetResult = { topic: string; outcome: RelaunchOutcome; reason?: string }

/** The caller speaks for the root when the root's agent is among its ancestors. */
export const callerIsRoot = (callerAncestry: readonly number[], rootAgentPid: number | undefined): boolean =>
  rootAgentPid !== undefined && callerAncestry.includes(rootAgentPid)

/** One target of the root's request: refused off its subtree, otherwise now, at its turn's end, or nothing to do. */
export function relaunchTarget(topic: string, root: string, facts: (topic: string) => TargetFacts | undefined): TargetResult {
  const own = facts(topic)
  if (!own) return { topic, outcome: 'refused', reason: 'unknown topic' }
  if (!descendsFrom(topic, root, t => facts(t)?.parent ?? null)) return { topic, outcome: 'refused', reason: `not under ${root}` }
  if (!own.running) return { topic, outcome: 'no_agent' }
  return { topic, outcome: own.idle ? 'applied' : 'queued' }
}
