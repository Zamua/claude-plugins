import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { keepProviderUsage } from './crook-usage-file'
import { providerCapacity } from './domain/provider-capacity'

function usageFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'crook-usage-')), 'crook', 'usage.json')
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('Crook usage file', () => {
  test('a provider write replaces only that provider, in Crook window names, 0600', () => {
    const file = usageFile()
    keepProviderUsage(file, providerCapacity('anthropic', [{ name: '5 hour', usedPercent: 10, availability: 'available' }], 1))
    keepProviderUsage(file, providerCapacity('codex', [
      { name: '5 hour', usedPercent: 100, resetsAt: 200_000, availability: 'exhausted' },
      { name: '1 week', usedPercent: 40, resetsAt: 900_000, availability: 'available' },
    ], 5_000))
    keepProviderUsage(file, providerCapacity('opencode-go', [
      { name: 'weekly', availability: 'unknown' },
      { name: 'monthly', usedPercent: 3, availability: 'available' },
    ], 6_000))

    expect(read(file).providers).toEqual({
      anthropic: { windows: [{ name: '5 hour', used_percent: 10, availability: 'available' }], observed_at: 1 },
      codex: {
        windows: [
          { name: '5 hour', used_percent: 100, availability: 'exhausted', resets_at: 200_000 },
          { name: '7 day', used_percent: 40, availability: 'available', resets_at: 900_000 },
        ],
        observed_at: 5_000,
      },
      'opencode-go': {
        windows: [
          { name: '7 day', availability: 'unknown' },
          { name: 'monthly', used_percent: 3, availability: 'available' },
        ],
        observed_at: 6_000,
      },
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('a probe with no windows leaves the provider absent', () => {
    const file = usageFile()
    keepProviderUsage(file, providerCapacity('anthropic', [{ name: '7 day', usedPercent: 1, availability: 'available' }], 1))
    keepProviderUsage(file, providerCapacity('codex', [], 2))
    expect(Object.keys(read(file).providers)).toEqual(['anthropic'])
  })

  test('an unreadable file is replaced', () => {
    const file = usageFile()
    keepProviderUsage(file, providerCapacity('anthropic', [{ name: '7 day', usedPercent: 1, availability: 'available' }], 1))
    writeFileSync(file, 'not json')
    keepProviderUsage(file, providerCapacity('codex', [{ name: '5 hour', usedPercent: 2, availability: 'available' }], 2))
    expect(Object.keys(read(file).providers)).toEqual(['codex'])
  })
})
