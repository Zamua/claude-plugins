import { describe, expect, test } from 'bun:test'
import {
  autoCompactWindow,
  DEFAULT_ROUTE,
  exhaustedRouteFor,
  forgetExhaustedProvider,
  normalizeModel,
  planRouteChange,
  rememberExhaustedRoute,
  topicRoute,
  topicRouteFromRecord,
} from './model-routing'

describe('TopicRoute', () => {
  test('normalizes OpenCode Go models without changing provider ownership', () => {
    expect(topicRoute({ provider: 'opencode-go', model: 'glm-5.2' })).toEqual({
      provider: 'opencode-go',
      model: 'opencode-go/glm-5.2',
      effort: 'auto',
      ultracode: false,
    })
  })

  test('keeps Ultracode off by default and pins it to xhigh when enabled', () => {
    expect(DEFAULT_ROUTE.ultracode).toBeFalse()
    expect(topicRoute({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      ultracode: true,
    })).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      ultracode: true,
    })
  })

  test('rejects a non-Codex model on the Codex route', () => {
    expect(() => normalizeModel('codex', 'glm-5.2')).toThrow('invalid Codex model')
  })

  test('migrates an implicit legacy Sol xhigh route to medium with Ultracode off', () => {
    expect(topicRouteFromRecord({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' })).toEqual({
      provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium', ultracode: false,
    })
    expect(topicRouteFromRecord({
      provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', ultracode: false,
    })?.effort).toBe('xhigh')
  })
})

describe('automatic compaction policy', () => {
  test('lets native Anthropic choose its own window', () => {
    expect(autoCompactWindow('anthropic', 1_000_000)).toBeUndefined()
  })

  test('keeps Codex at the long-context pricing boundary', () => {
    expect(autoCompactWindow('codex', 1_050_000)).toBe(272_000)
  })

  test('uses OpenCode model metadata and clamps to Claude Code limits', () => {
    expect(autoCompactWindow('opencode-go', 1_000_000)).toBe(1_000_000)
    expect(autoCompactWindow('opencode-go', 1_048_576)).toBe(1_000_000)
    expect(autoCompactWindow('opencode-go', 202_752)).toBe(202_752)
  })

  test('uses a conservative explicit fallback when metadata is unavailable', () => {
    expect(autoCompactWindow('opencode-go')).toBe(200_000)
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
