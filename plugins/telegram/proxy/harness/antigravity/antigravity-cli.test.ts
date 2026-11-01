import { describe, expect, test } from 'bun:test'
import {
  parseAntigravityModels,
  parseAntigravityUsage,
} from './antigravity-cli'

const models = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n')

describe('Antigravity CLI adapter', () => {
  test('groups concrete CLI variants into model then effort choices', () => {
    expect(parseAntigravityModels(models)).toEqual([
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        variants: {
          low: 'gemini-3.8-flash-low',
          medium: 'gemini-3.8-flash-medium',
          high: 'gemini-3.8-flash-high',
        },
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      {
        id: 'claude-opus-4-6-thinking',
        label: 'Claude Opus 4.6 (Thinking)',
        variants: {},
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      {
        id: 'gpt-oss-120b',
        label: 'GPT-OSS 120B',
        variants: { medium: 'gpt-oss-120b-medium' },
        efforts: ['medium'],
        defaultEffort: 'medium',
      },
    ])
  })

  test('parses quota windows and exact resets', () => {
    const usage = parseAntigravityUsage([
      'Gemini Models\tWeekly Limit Remaining\t98%\t2026-09-09T16:18:59Z',
      'Gemini Models\tFive Hour Limit Remaining\t97%\t2026-09-02T21:18:59Z',
      'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-09T16:21:01Z',
    ].join('\n'))
    expect(usage).toHaveLength(3)
    expect(usage[0]).toEqual({
      pool: 'Gemini Models', window: 'weekly', remainingPercent: 98,
      resetsAt: Date.parse('2026-09-09T16:18:59Z'),
    })
  })
})
