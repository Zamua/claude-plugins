// A turn the proxy typed into a proxied Claude's pane, from submission until the pane settles. The pane pump samples
// the pane and sends each sample here; only a settled pane takes the next turn.
import type { AgentRuntime } from '../../shared/herdr-panes'

// A turn that finishes between two samples is never seen busy, so an idle pane this long after submission is settled.
export const MISSED_EDGE_MS = 5_000

export type PaneTurn =
  | { state: 'settled' }
  /** Typed in and accepted, not yet seen running. */
  | { state: 'submitted'; at: number }
  /** Seen running since it was typed in. */
  | { state: 'running'; at: number }

export type PaneTurnEvent =
  | { type: 'submitted'; now: number }
  | { type: 'sampled'; runtime: AgentRuntime; now: number }
  /** The agent was stopped, so no turn is running in it. */
  | { type: 'stopped' }

export function nextTurn(turn: PaneTurn, event: PaneTurnEvent): PaneTurn {
  switch (event.type) {
    case 'submitted':
      return { state: 'submitted', at: event.now }
    case 'stopped':
      return { state: 'settled' }
    case 'sampled':
      return sampled(turn, event.runtime, event.now)
    default: {
      const unhandled: never = event
      throw new Error(`unhandled pane turn event ${JSON.stringify(unhandled)}`)
    }
  }
}

function sampled(turn: PaneTurn, runtime: AgentRuntime, now: number): PaneTurn {
  switch (turn.state) {
    case 'settled':
      return turn
    case 'submitted':
      if (runtime === 'busy' || runtime === 'blocked' || runtime === 'starting') return { state: 'running', at: turn.at }
      return runtime === 'idle' && now - turn.at >= MISSED_EDGE_MS ? { state: 'settled' } : turn
    case 'running':
      return runtime === 'idle' ? { state: 'settled' } : turn
    default: {
      const unhandled: never = turn
      throw new Error(`unhandled pane turn state ${JSON.stringify(unhandled)}`)
    }
  }
}
