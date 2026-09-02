import { describe, expect, test } from 'bun:test'
import {
  antigravityArgs,
  parseAntigravityModels,
  parseAntigravityResult,
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

  test('builds a shell-free, permissionless headless turn on the same conversation', () => {
    expect(antigravityArgs({
      prompt: 'hello',
      modelVariant: 'gemini-3.8-flash-low',
      effort: 'low',
      conversationId: 'conv-1',
    })).toEqual([
      '--model', 'gemini-3.8-flash-low',
      '--effort', 'low',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--print-timeout', '30m',
      '--conversation', 'conv-1',
      '-p', 'hello',
    ])
  })

  test('parses the final response and durable conversation identity', () => {
    expect(parseAntigravityResult(JSON.stringify({
      conversation_id: 'conv-1', status: 'SUCCESS', response: 'done\n',
    }))).toEqual({ conversationId: 'conv-1', response: 'done', status: 'SUCCESS' })
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
