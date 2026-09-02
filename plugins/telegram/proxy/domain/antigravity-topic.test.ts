import { describe, expect, test } from 'bun:test'
import {
  antigravityRoute,
  antigravitySessionName,
  antigravityTopic,
  applyAntigravityPending,
  renderAntigravityKickoff,
  renderAntigravityTurn,
  requestAntigravityRoute,
  requestAntigravityRestart,
  selectAntigravityVariant,
  withAntigravitySession,
} from './antigravity-topic'

const flash = {
  id: 'gemini-3.8-flash',
  label: 'Gemini 3.8 Flash',
  variants: {
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high',
  },
  efforts: ['low', 'medium', 'high'] as const,
  defaultEffort: 'medium' as const,
}

describe('Antigravity topic', () => {
  test('keeps provider identity below the Antigravity harness', () => {
    expect(antigravityRoute(flash, 'high')).toEqual({
      model: 'gemini-3.8-flash',
      modelLabel: 'Gemini 3.8 Flash',
      modelVariant: 'gemini-3.8-flash-high',
      effort: 'high',
    })
    expect(selectAntigravityVariant(flash, 'low')).toBe('gemini-3.8-flash-low')
  })

  test('rejects an effort that the live catalog did not expose', () => {
    expect(() => antigravityRoute(flash, 'xhigh' as any)).toThrow('unsupported Antigravity effort')
  })

  test('marks the aggregate as harness-locked', () => {
    const topic = antigravityTopic('42', 'antigravity pilot', antigravityRoute(flash, 'medium'), 10)
    expect(topic.harness).toBe('antigravity')
    expect(topic.conversationId).toBeUndefined()
  })

  test('uses a readable, stable Herdr session name', () => {
    expect(antigravitySessionName('42', 'Antigravity Pilot!')).toBe('agy-antigravity-pilot-42')
  })

  test('persists pane identity with the exact conversation', () => {
    const topic = antigravityTopic('42', 'pilot', antigravityRoute(flash, 'medium'), 10)
    const running = withAntigravitySession(topic, 'agy-pilot-42', 'conv-1', 20)
    expect(running.sessionName).toBe('agy-pilot-42')
    expect(running.conversationId).toBe('conv-1')
  })

  test('queues route and restart changes until the current turn is safe to stop', () => {
    const topic = antigravityTopic('42', 'pilot', antigravityRoute(flash, 'medium'), 10)
    const next = antigravityRoute(flash, 'high')
    const requested = requestAntigravityRestart(requestAntigravityRoute(topic, next, 20), 30)
    expect(requested.route.effort).toBe('medium')
    expect(requested.pendingRoute?.effort).toBe('high')
    expect(requested.restartPending).toBeTrue()
    const applied = applyAntigravityPending(requested, 40)
    expect(applied.route.effort).toBe('high')
    expect(applied.pendingRoute).toBeUndefined()
    expect(applied.restartPending).toBeUndefined()
  })

  test('imports Claude guidance and requires outbound Telegram MCP delivery', () => {
    const kickoff = renderAntigravityKickoff()
    const turn = renderAntigravityTurn({
      content: 'check the GPU project',
      meta: { chat_id: '-1001', user: 'zamua', message_thread_id: '42' },
    })
    expect(kickoff).toContain('CLAUDE.md')
    expect(kickoff).toContain('.agents/skills')
    expect(kickoff).toContain('.claude/skills')
    expect(kickoff).toContain('persistent Herdr workspace')
    expect(turn).toContain('<channel source="telegram"')
    expect(turn).toContain('check the GPU project')
    expect(turn).toContain('Telegram MCP reply tool')
  })
})
