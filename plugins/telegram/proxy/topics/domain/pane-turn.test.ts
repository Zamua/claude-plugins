import { describe, expect, test } from 'bun:test'
import { MISSED_EDGE_MS, nextTurn } from './pane-turn'
import type { PaneTurn, PaneTurnEvent } from './pane-turn'

const states = (turn: PaneTurn, events: PaneTurnEvent[]) =>
  events.map(event => (turn = nextTurn(turn, event)).state)

const sample = (runtime: 'idle' | 'busy' | 'blocked' | 'starting' | 'missing', now = 1_000): PaneTurnEvent =>
  ({ type: 'sampled', runtime, now })

describe('nextTurn', () => {
  test('a turn settles once the pane is seen running and then idle', () => {
    expect(states({ state: 'settled' }, [
      { type: 'submitted', now: 0 }, sample('idle', 100), sample('busy', 200), sample('busy', 300), sample('idle', 400),
    ])).toEqual(['submitted', 'submitted', 'running', 'running', 'settled'])
  })

  test('a turn too short to be seen running settles after the missed-edge window', () => {
    expect(states({ state: 'settled' }, [
      { type: 'submitted', now: 0 }, sample('idle', MISSED_EDGE_MS - 1), sample('idle', MISSED_EDGE_MS),
    ])).toEqual(['submitted', 'submitted', 'settled'])
  })

  test('a pane waiting on approval or gone keeps the turn open', () => {
    expect(states({ state: 'submitted', at: 0 }, [sample('blocked'), sample('missing', 99_000)])).toEqual(['running', 'running'])
    expect(states({ state: 'submitted', at: 0 }, [sample('missing', 99_000)])).toEqual(['submitted'])
  })

  test('stopping the agent mid-turn settles it, so the restarted pane takes the next turn', () => {
    expect(states({ state: 'running', at: 0 }, [{ type: 'stopped' }, sample('busy')])).toEqual(['settled', 'settled'])
  })
})
