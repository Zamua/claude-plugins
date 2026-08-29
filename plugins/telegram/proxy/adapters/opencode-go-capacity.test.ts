import { describe, expect, test } from 'bun:test'
import { parseOpenCodeGoCapacity } from './opencode-go-capacity'

describe('OpenCode Go capacity adapter', () => {
  test('maps the rolling, weekly, and monthly contract', () => {
    const capacity = parseOpenCodeGoCapacity({
      usage: {
        rolling: { status: 'rate-limited', percent: 100, resetsAt: '2026-08-29T17:00:00Z' },
        weekly: { status: 'ok', percent: 59, resetsAt: '2026-08-31T00:00:00Z' },
        monthly: { status: 'ok', percent: 47, resetsAt: '2026-09-21T00:44:00Z' },
      },
    }, 1)
    expect(capacity.availability).toBe('exhausted')
    expect(capacity.windows.map(window => [window.name, window.usedPercent])).toEqual([
      ['5 hour', 100], ['weekly', 59], ['monthly', 47],
    ])
  })
})
