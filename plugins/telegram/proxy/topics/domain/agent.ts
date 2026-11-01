// A Claude topic's agent process, as the proxy knows it. Every change goes through nextAgent; the shell in
// topics/lifecycle.ts observes the multiplexer, passes what it saw in the event, and performs the effects.

/** How long after a start the agent counts as running although the multiplexer cannot see it yet. */
export const START_GRACE_MS = 30_000

export type Agent =
  /** No process: never started, stopped, or found dead at boot. */
  | { state: 'stopped' }
  /**
   * Started or adopted under `session`, the multiplexer name dedup and kill use (never re-derived, since it follows
   * the topic's label). `profile` is the launch profile version it got; absent, it predates versioned profiles.
   */
  | { state: 'running'; session: string; since: number; profile?: number }
  /** The last start failed, or the bound conversation is missing on disk. Only a new event tries again. */
  | { state: 'failed'; since: number }

export type AgentEvent =
  /**
   * Something needs the agent: a message, a relaunch, a route change (`event`), or the pane pump's timer (`timer`).
   * `live` says whether the multiplexer sees the running session, and `legacy` names a live old-scheme session the
   * topic could adopt.
   */
  | { type: 'wanted'; by: 'event' | 'timer'; now: number; live: boolean; legacy?: string }
  | { type: 'started'; session: string; now: number; profile: number }
  | { type: 'start-failed'; now: number }
  /** About to start, the bound conversation's transcript is gone; a fresh one would silently drop the topic's history. */
  | { type: 'conversation-missing'; now: number }
  /** Killed, or replaced: whatever ran is gone. */
  | { type: 'stopped' }
  /** A registry entry at boot, with whether its recorded session is still live. */
  | { type: 'restored'; session: string; since: number; profile?: number; live: boolean }

export type AgentEffect =
  | { type: 'start' }
  | { type: 'report-missing-conversation' }
  /** Answer the dead process's long-polls, so nothing enqueued next is handed to it. */
  | { type: 'drain-waiters' }
  | { type: 'save' }

export type AgentStep = { agent: Agent; effects: AgentEffect[] }

const stay = (agent: Agent): AgentStep => ({ agent, effects: [] })

export function nextAgent(agent: Agent, event: AgentEvent): AgentStep {
  switch (event.type) {
    case 'wanted':
      return wanted(agent, event)
    case 'started':
      return {
        agent: { state: 'running', session: event.session, since: event.now, profile: event.profile },
        effects: [{ type: 'save' }],
      }
    case 'start-failed':
      return stay({ state: 'failed', since: event.now })
    case 'conversation-missing':
      return { agent: { state: 'failed', since: event.now }, effects: [{ type: 'report-missing-conversation' }] }
    case 'stopped':
      return { agent: { state: 'stopped' }, effects: [{ type: 'drain-waiters' }] }
    case 'restored':
      return stay(
        event.live
          ? { state: 'running', session: event.session, since: event.since, ...(event.profile !== undefined && { profile: event.profile }) }
          : { state: 'stopped' },
      )
    default: {
      const unhandled: never = event
      throw new Error(`unhandled agent event ${JSON.stringify(unhandled)}`)
    }
  }
}

function wanted(agent: Agent, event: Extract<AgentEvent, { type: 'wanted' }>): AgentStep {
  switch (agent.state) {
    case 'running': {
      // Inside the grace window a new pane is still running although herdr reports it `unknown` for its first seconds
      const booting = agent.since > 0 && event.now - agent.since < START_GRACE_MS
      if (event.live && agent.since === 0) {
        return { agent: { ...agent, since: event.now }, effects: [{ type: 'save' }] }
      }
      if (event.live || booting) return stay(agent)
      // Found dead: start it again, without looking for an old-scheme session it was never under
      return start(agent)
    }
    case 'failed':
      // The topic notice promises a retry on the next message or /relaunch, not on a timer
      if (event.by === 'timer') return stay(agent)
      return adoptOrStart(agent, event)
    case 'stopped':
      return adoptOrStart(agent, event)
    default: {
      const unhandled: never = agent
      throw new Error(`unhandled agent state ${JSON.stringify(unhandled)}`)
    }
  }
}

// An untracked live session under the old `tg-<cid>-<tid>` name is adopted rather than doubled, since the launcher's
// own guard checks only the new name.
function adoptOrStart(agent: Agent, event: Extract<AgentEvent, { type: 'wanted' }>): AgentStep {
  if (event.legacy) {
    return { agent: { state: 'running', session: event.legacy, since: event.now }, effects: [{ type: 'save' }] }
  }
  return start(agent)
}

const start = (agent: Agent): AgentStep => ({ agent, effects: [{ type: 'start' }] })

/** The session the agent runs under, if it is running. */
export const sessionOf = (agent: Agent): string | undefined => (agent.state === 'running' ? agent.session : undefined)
