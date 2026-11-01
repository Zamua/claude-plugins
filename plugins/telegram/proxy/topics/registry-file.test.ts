import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readRegistryFile, writeRegistryFile } from './registry-file'
import type { Registry } from './registry-file'

const entry = (session: string) => ({
  tmux_session: `claude-x-${session}`,
  thread_id: 42,
  name: 'x',
  spawned_at: 1,
  claude_session_id: session,
})

let lockedDir: string | undefined
afterEach(() => {
  if (lockedDir) chmodSync(lockedDir, 0o700)
  lockedDir = undefined
})

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'))
  return { dir, file: join(dir, 'registry.json') }
}
const quiet = () => {
  const lines: string[] = []
  return { lines, log: (m: string) => { lines.push(m) } }
}

describe('readRegistryFile', () => {
  test('a missing file is an empty registry, not an error', () => {
    const { file } = fresh()
    const { lines, log } = quiet()
    expect(readRegistryFile(file, log)).toEqual({})
    expect(lines).toEqual([])
  })

  test('round-trips what writeRegistryFile wrote', () => {
    const { file } = fresh()
    const registry: Registry = { '7': entry('s7'), general: entry('sg') }
    writeRegistryFile(file, registry)
    expect(readRegistryFile(file, () => {})).toEqual(registry)
  })

  test('an unreadable file keeps its conversation ids through the load-then-save cycle', () => {
    const { dir, file } = fresh()
    const corrupt = '{"7": {"claude_session_id": "keep-me"'
    writeFileSync(file, corrupt)
    const { lines, log } = quiet()

    const loaded = readRegistryFile(file, log, 1234)
    writeRegistryFile(file, loaded)

    expect(loaded).toEqual({})
    expect(readFileSync(join(dir, 'registry.json.unreadable-1234'), 'utf8')).toBe(corrupt)
    expect(lines.join('\n')).toContain('registry.json.unreadable-1234')
  })

  test('valid JSON that is not an object is set aside too', () => {
    for (const body of ['null', '[]', '"x"']) {
      const { dir, file } = fresh()
      writeFileSync(file, body)
      expect(readRegistryFile(file, () => {}, 5)).toEqual({})
      expect(existsSync(file)).toBeFalse()
      expect(readFileSync(join(dir, 'registry.json.unreadable-5'), 'utf8')).toBe(body)
    }
  })

  test('drops a malformed entry and keeps the rest', () => {
    const { file } = fresh()
    writeFileSync(file, JSON.stringify({ '7': entry('s7'), '8': null, '9': 'junk' }))
    const { lines, log } = quiet()
    expect(readRegistryFile(file, log)).toEqual({ '7': entry('s7') })
    expect(lines).toHaveLength(2)
  })

  test('refuses to continue when an unreadable file cannot be moved aside', () => {
    const { dir, file } = fresh()
    writeFileSync(file, 'not json')
    chmodSync(dir, 0o500)
    lockedDir = dir
    expect(() => readRegistryFile(file, () => {})).toThrow(/could not be moved aside/)
    chmodSync(dir, 0o700)
    lockedDir = undefined
    expect(readFileSync(file, 'utf8')).toBe('not json')
    expect(readdirSync(dir)).toEqual(['registry.json'])
  })
})
