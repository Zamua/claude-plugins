import { describe, expect, test } from 'bun:test'
import { parseCodexCapacity, parseCodexModels } from './codex-app-server'

describe('Codex app-server adapter', () => {
  test('maps account models and intersects effort with Claude Code', () => {
    const models = parseCodexModels({ data: [{
      id: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      hidden: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'ultra' },
      ],
      serviceTiers: [{ id: 'priority' }],
    }] })
    expect(models).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'high'], defaultEffort: 'high', supportsUltracode: false },
      { id: 'gpt-5.6-sol-fast', label: 'GPT-5.6 Sol Fast', efforts: ['low', 'high'], defaultEffort: 'high', supportsUltracode: false },
    ])
  })

  test('maps quota windows, reset times, and banked reset count', () => {
    const capacity = parseCodexCapacity({
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 200 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 900 },
      },
      rateLimitResetCredits: { availableCount: 1 },
    }, 100_000)
    expect(capacity.availability).toBe('exhausted')
    expect(capacity.windows).toEqual([
      { name: '5 hour', usedPercent: 100, resetsAt: 200_000, availability: 'exhausted' },
      { name: '1 week', usedPercent: 40, resetsAt: 900_000, availability: 'available' },
    ])
    expect(capacity.resetCredits).toBe(1)
  })
})
