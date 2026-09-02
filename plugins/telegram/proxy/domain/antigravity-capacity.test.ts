import { describe, expect, test } from 'bun:test'
import { antigravityResetPools, antigravityUsageAvailability } from './antigravity-capacity'

const window = (pool: string, name: string, remainingPercent: number) => ({
  pool, window: name, remainingPercent, resetsAt: 100,
})

describe('Antigravity capacity', () => {
  test('a pool remains exhausted until all of its limiting windows recover', () => {
    expect(antigravityUsageAvailability([
      window('Gemini', 'weekly', 0),
      window('Gemini', 'five-hour', 100),
    ])).toEqual(new Map([['Gemini', 'exhausted']]))
  })

  test('reports only exhausted-to-available pool transitions', () => {
    const before = [window('Gemini', 'weekly', 0), window('Claude/GPT', 'weekly', 50)]
    const after = [window('Gemini', 'weekly', 100), window('Claude/GPT', 'weekly', 60)]
    expect(antigravityResetPools(before, after)).toEqual(['Gemini'])
    expect(antigravityResetPools([], after)).toEqual([])
  })
})
