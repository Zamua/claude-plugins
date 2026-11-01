import { describe, expect, test } from 'bun:test'
import { nextAgent, START_GRACE_MS } from './agent'
import type { Agent, AgentEvent } from './agent'

const wanted = (over: Partial<Extract<AgentEvent, { type: 'wanted' }>> = {}): AgentEvent => ({
  type: 'wanted', by: 'event', now: 100_000, live: false, ...over,
})

// Feeds events in order, returning every step's state and effect types.
function run(agent: Agent, events: AgentEvent[]) {
  return events.map(event => {
    const step = nextAgent(agent, event)
    agent = step.agent
    return { state: step.agent.state, effects: step.effects.map(e => e.type) }
  })
}

describe('nextAgent', () => {
  test('a first message starts the agent, and a start that succeeds runs it and is saved', () => {
    expect(run({ state: 'stopped' }, [wanted(), { type: 'started', session: 'claude-x-1', now: 100_000, profile: 4 }])).toEqual([
      { state: 'stopped', effects: ['start'] },
      { state: 'running', effects: ['save'] },
    ])
  })

  test('a running agent the multiplexer sees, or one still inside its start grace, is left alone', () => {
    const running: Agent = { state: 'running', session: 'claude-x-1', since: 100_000 }
    expect(nextAgent(running, wanted({ live: true, now: 500_000 })).effects).toEqual([])
    expect(nextAgent(running, wanted({ live: false, now: 100_000 + START_GRACE_MS - 1 })).effects).toEqual([])
  })

  test('a running agent found dead after its grace starts again under the same conversation', () => {
    const running: Agent = { state: 'running', session: 'claude-x-1', since: 100_000 }
    expect(nextAgent(running, wanted({ now: 100_000 + START_GRACE_MS })).effects).toEqual([{ type: 'start' }])
  })

  test('an adopted session with no start time takes the first moment it is seen live', () => {
    const step = nextAgent({ state: 'running', session: 'claude-x-1', since: 0 }, wanted({ live: true, now: 7 }))
    expect(step).toEqual({ agent: { state: 'running', session: 'claude-x-1', since: 7 }, effects: [{ type: 'save' }] })
  })

  test('a failed start is retried by the next event, never by the pane timer', () => {
    expect(run({ state: 'stopped' }, [
      wanted(),
      { type: 'start-failed', now: 100_000 },
      wanted({ by: 'timer' }),
      wanted({ by: 'timer' }),
      wanted({ by: 'event' }),
    ])).toEqual([
      { state: 'stopped', effects: ['start'] },
      { state: 'failed', effects: [] },
      { state: 'failed', effects: [] },
      { state: 'failed', effects: [] },
      { state: 'failed', effects: ['start'] },
    ])
  })

  test('a missing conversation is reported and nothing starts, until an event asks again', () => {
    expect(run({ state: 'stopped' }, [
      wanted(),
      { type: 'conversation-missing', now: 100_000 },
      wanted({ by: 'timer' }),
      wanted(),
    ])).toEqual([
      { state: 'stopped', effects: ['start'] },
      { state: 'failed', effects: ['report-missing-conversation'] },
      { state: 'failed', effects: [] },
      { state: 'failed', effects: ['start'] },
    ])
  })

  test('a stopped topic adopts a live old-scheme session instead of starting a second', () => {
    expect(nextAgent({ state: 'stopped' }, wanted({ legacy: 'tg-100-1', now: 9 }))).toEqual({
      agent: { state: 'running', session: 'tg-100-1', since: 9 },
      effects: [{ type: 'save' }],
    })
  })

  test('a running agent found dead never adopts an old-scheme session it was not under', () => {
    const dead: Agent = { state: 'running', session: 'claude-x-1', since: 1 }
    expect(nextAgent(dead, wanted({ legacy: 'tg-100-1' })).effects).toEqual([{ type: 'start' }])
  })

  test('stopping drains the long-polls of whatever ran, from any state', () => {
    for (const agent of [{ state: 'stopped' }, { state: 'failed', since: 1 }, { state: 'running', session: 's', since: 1 }] as Agent[]) {
      expect(nextAgent(agent, { type: 'stopped' })).toEqual({ agent: { state: 'stopped' }, effects: [{ type: 'drain-waiters' }] })
    }
  })

  test('a registry entry restores as running only while its session is live', () => {
    const entry = { type: 'restored', session: 'claude-x-1', since: 5, profile: 4 } as const
    expect(nextAgent({ state: 'stopped' }, { ...entry, live: true }).agent).toEqual({ state: 'running', session: 'claude-x-1', since: 5, profile: 4 })
    expect(nextAgent({ state: 'stopped' }, { ...entry, live: false }).agent).toEqual({ state: 'stopped' })
  })
})
