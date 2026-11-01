import { describe, expect, test } from 'bun:test'
import { topicRoute } from './model-routing'
import type { TopicRoute } from './model-routing'
import { nextRoute, ROUTE_DEBOUNCE_MS } from './route-flow'
import type { RouteEvent, RouteFlow } from './route-flow'

const opus55 = topicRoute({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'xhigh' })
const opus = topicRoute({ provider: 'anthropic', model: 'opus' })
const sol = topicRoute({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
const start = (route: TopicRoute = opus55): RouteFlow => ({ route, exhausted: [] })

const limited = (over: Partial<Extract<RouteEvent, { type: 'rate-limited' }>> = {}): RouteEvent =>
  ({ type: 'rate-limited', agentRunning: true, limitedProviders: [], now: 1_000_000, ...over })
const picked = (route: TopicRoute, over: Partial<Extract<RouteEvent, { type: 'requested' }>> = {}): RouteEvent =>
  ({ type: 'requested', route, reason: 'manual', busy: false, byOperator: true, now: 1_000_000, ...over })

// Feeds events in order and returns each step's outcome, effect types and running route.
function run(flow: RouteFlow, events: RouteEvent[]) {
  const steps = events.map(event => {
    const step = nextRoute(flow, event)
    flow = step.flow
    return { outcome: step.outcome, effects: step.effects.map(e => e.type), model: step.flow.route.model }
  })
  return { steps, flow }
}

describe('nextRoute', () => {
  test('a pick while idle restarts on it at once; while busy it waits for the turn to end', () => {
    expect(run(start(), [picked(sol)]).steps).toEqual([
      { outcome: 'applied', effects: ['stop-agent', 'save', 'start-agent'], model: 'gpt-5.6-sol' },
    ])
    const busy = run(start(), [picked(sol, { busy: true }), { type: 'turn-ended' }, { type: 'turn-ended' }])
    expect(busy.steps).toEqual([
      { outcome: 'queued', effects: ['save', 'await-boundary'], model: 'claude-opus-5-5' },
      { outcome: 'applied', effects: ['stop-agent', 'save', 'start-agent'], model: 'gpt-5.6-sol' },
      { outcome: 'none', effects: [], model: 'gpt-5.6-sol' },
    ])
  })

  test('a second operator pick inside the debounce window is ignored', () => {
    const { steps } = run(start(), [picked(sol), picked(opus55, { now: 1_000_000 + ROUTE_DEBOUNCE_MS - 1 })])
    expect(steps.map(s => s.outcome)).toEqual(['applied', 'too-soon'])
  })

  test('a limit walks the chain, owes the resumed session a notice, and keeps the limited route to offer back', () => {
    const { steps, flow } = run(start(), [
      limited({ ranOn: { provider: 'anthropic', model: 'claude-opus-5-5' } }),
      // The Fable session hits its own limit seconds later
      limited({ ranOn: { provider: 'anthropic', model: 'fable' }, now: 1_000_005 }),
    ])
    expect(steps).toEqual([
      { outcome: 'fell-back', effects: ['stop-agent', 'save', 'start-agent', 'announce-fallback'], model: 'fable' },
      { outcome: 'fell-back', effects: ['stop-agent', 'save', 'start-agent', 'announce-fallback'], model: 'opus' },
    ])
    expect(flow.resumeNotice).toContain('fable reached its usage limit')
    expect(flow.exhausted.map(r => r.model)).toEqual(['fable'])
  })

  test('a report from the process a change replaced is a duplicate, by its route or, when it names none, by the clock', () => {
    const fell = nextRoute(start(), limited({ ranOn: { provider: 'anthropic', model: 'claude-opus-5-5' } })).flow
    expect(nextRoute(fell, limited({ ranOn: { provider: 'anthropic', model: 'claude-opus-5-5' }, now: 9_000_000 })).outcome).toBe('duplicate')
    expect(nextRoute(fell, limited({ now: 1_000_000 + ROUTE_DEBOUNCE_MS - 1 })).outcome).toBe('duplicate')
    expect(nextRoute(fell, limited({ now: 1_000_000 + ROUTE_DEBOUNCE_MS })).outcome).toBe('fell-back')
  })

  test('the end of the chain stops the agent and asks the operator; its repeat while stopped is a duplicate', () => {
    const { steps } = run(start(opus), [limited({ resetAt: 5 }), limited({ agentRunning: false, now: 9_000_000 })])
    expect(steps).toEqual([
      { outcome: 'stopped-at-limit', effects: ['stop-agent', 'save', 'announce-limit'], model: 'opus' },
      { outcome: 'duplicate', effects: [], model: 'opus' },
    ])
  })

  test('a provider without a fallback, or a fallback whose provider is out, stops at the limit', () => {
    expect(nextRoute(start(sol), limited()).outcome).toBe('stopped-at-limit')
    expect(nextRoute(start(), limited({ limitedProviders: ['anthropic'] })).outcome).toBe('stopped-at-limit')
  })

  test('switch-back returns to the recorded route and forgets it; it refuses when nothing is recorded or the provider is still out', () => {
    const fell = nextRoute(start(), limited()).flow
    expect(nextRoute(start(), { type: 'switch-back', provider: 'anthropic', busy: false, limitedProviders: [], now: 9_000_000 }).outcome)
      .toBe('nothing-to-return')
    expect(nextRoute(fell, { type: 'switch-back', provider: 'anthropic', busy: false, limitedProviders: ['anthropic'], now: 9_000_000 }).outcome)
      .toBe('still-limited')
    const back = nextRoute(fell, { type: 'switch-back', provider: 'anthropic', busy: false, limitedProviders: [], now: 9_000_000 })
    expect(back.outcome).toBe('applied')
    expect(back.flow.route).toEqual(opus55)
    expect(back.flow.exhausted).toEqual([])
  })

  test('switch-back to the route already running only forgets the record', () => {
    const flow: RouteFlow = { route: opus55, exhausted: [opus55] }
    const step = nextRoute(flow, { type: 'switch-back', provider: 'anthropic', busy: false, limitedProviders: [], now: 9_000_000 })
    expect([step.outcome, step.effects.map(e => e.type), step.flow.exhausted]).toEqual(['unchanged', ['save'], []])
  })

  test('the resume notice clears once delivered, and a stale launch profile queues a refresh unless a change waits', () => {
    expect(nextRoute({ ...start(), resumeNotice: 'n' }, { type: 'notice-delivered' }).flow.resumeNotice).toBeUndefined()
    expect(nextRoute(start(), { type: 'profile-stale', now: 3 }).flow.pending).toEqual({ route: opus55, reason: 'migration', requestedAt: 3 })
    const waiting = { ...start(), pending: { route: sol, reason: 'manual' as const, requestedAt: 1 } }
    expect(nextRoute(waiting, { type: 'profile-stale', now: 3 }).flow.pending?.route).toEqual(sol)
  })
})
