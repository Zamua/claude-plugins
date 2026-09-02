import { describe, expect, test } from 'bun:test'
import {
  antigravityRoute,
  antigravityTopic,
  renderAntigravityTurn,
  selectAntigravityVariant,
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

  test('imports Claude guidance without pretending Claude channel mechanics work', () => {
    const turn = renderAntigravityTurn({
      content: 'check the GPU project',
      meta: { chat_id: '-1001', user: 'zamua', message_thread_id: '42' },
    }, true)
    expect(turn).toContain('CLAUDE.md')
    expect(turn).toContain('.agents/skills')
    expect(turn).toContain('.claude/skills')
    expect(turn).toContain('Do not call a Claude Telegram reply tool')
    expect(turn).toContain('<channel source="telegram"')
    expect(turn).toContain('check the GPU project')
  })
})
