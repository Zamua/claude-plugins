import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consoleLoginToken, parseOpenCodeGoCapacity, readOpenCodeGoKey } from './opencode-go-capacity'

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

describe('OpenCode Go credential', () => {
  const login = (fields: Record<string, unknown>) => JSON.stringify([
    { integrationID: 'github', active: true, value: { access: 'not-this' } },
    { integrationID: 'opencode', active: true, value: { type: 'oauth', access: 'tok-123' }, ...fields },
  ])

  test('reads the active Console login token from an auth export', () => {
    expect(consoleLoginToken(login({}))).toBe('tok-123')
    expect(consoleLoginToken(login({ active: false }))).toBeUndefined()
    expect(consoleLoginToken('not json')).toBeUndefined()
  })

  test('an API key file wins over the Console login', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-go-key-'))
    try {
      const file = join(dir, 'key')
      writeFileSync(file, ' sk-file \n')
      expect(readOpenCodeGoKey(file, () => login({}))).toBe('sk-file')
      expect(readOpenCodeGoKey(join(dir, 'missing'), () => login({}))).toBe('tok-123')
      expect(() => readOpenCodeGoKey(join(dir, 'missing'), () => '[]')).toThrow('no OpenCode Go API key file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
