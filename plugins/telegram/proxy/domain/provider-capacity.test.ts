import { describe, expect, test } from 'bun:test'
import { capacityTransition, nextResetAt, providerCapacity } from './provider-capacity'

describe('ProviderCapacity', () => {
  test('one exhausted window exhausts the provider', () => {
    const capacity = providerCapacity('codex', [
      { name: '5 hour', usedPercent: 100, resetsAt: 200, availability: 'exhausted' },
      { name: 'weekly', usedPercent: 40, resetsAt: 900, availability: 'available' },
    ], 100)
    expect(capacity.availability).toBe('exhausted')
    expect(nextResetAt(capacity)).toBe(200)
  })

  test('detects exhaustion and reset once', () => {
    const available = providerCapacity('anthropic', [
      { name: '5 hour', usedPercent: 80, availability: 'available' },
    ], 100)
    const exhausted = providerCapacity('anthropic', [
      { name: '5 hour', usedPercent: 100, availability: 'exhausted' },
    ], 110)
    expect(capacityTransition(available, exhausted)).toBe('exhausted')
    expect(capacityTransition(exhausted, available)).toBe('reset')
    expect(capacityTransition(available, available)).toBe('none')
  })
})
