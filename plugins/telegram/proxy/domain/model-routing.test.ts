import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ROUTE,
  exhaustedRouteFor,
  forgetExhaustedProvider,
  normalizeModel,
  planRouteChange,
  rememberExhaustedRoute,
  topicRoute,
} from './model-routing'

describe('TopicRoute', () => {
  test('normalizes OpenCode Go models without changing provider ownership', () => {
    expect(topicRoute({ provider: 'opencode-go', model: 'glm-5.2' })).toEqual({
      provider: 'opencode-go',
      model: 'opencode-go/glm-5.2',
      effort: 'medium',
    })
  })

  test('rejects a non-Codex model on the Codex route', () => {
    expect(() => normalizeModel('codex', 'glm-5.2')).toThrow('invalid Codex model')
  })
})

describe('exhausted provider routes', () => {
  const anthropic = DEFAULT_ROUTE
  const codex = topicRoute({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
  const newerAnthropic = topicRoute({ provider: 'anthropic', model: 'opus', effort: 'max' })

  test('retains one exact return route per exhausted provider', () => {
    const routes = rememberExhaustedRoute(rememberExhaustedRoute([anthropic], codex), newerAnthropic)
    expect(routes).toEqual([codex, newerAnthropic])
    expect(exhaustedRouteFor(routes, 'anthropic')).toEqual(newerAnthropic)
  })

  test('forgets only the provider selected after its reset', () => {
    expect(forgetExhaustedProvider([anthropic, codex], 'anthropic')).toEqual([codex])
  })
})

describe('route change planning', () => {
  const codex = topicRoute({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })

  test('applies immediately when the Claude session is idle', () => {
    expect(planRouteChange(DEFAULT_ROUTE, codex, 'manual', 'idle', 10)).toEqual({
      kind: 'apply-now',
      route: codex,
      reason: 'manual',
    })
  })

  test('queues a switch at a turn boundary while Claude is busy', () => {
    expect(planRouteChange(DEFAULT_ROUTE, codex, 'quota', 'busy', 10)).toEqual({
      kind: 'wait-for-turn-boundary',
      pending: { route: codex, reason: 'quota', requestedAt: 10 },
    })
  })

  test('does not restart an already selected route', () => {
    expect(planRouteChange(codex, codex, 'manual', 'idle', 10)).toEqual({
      kind: 'unchanged',
      route: codex,
    })
  })
})
