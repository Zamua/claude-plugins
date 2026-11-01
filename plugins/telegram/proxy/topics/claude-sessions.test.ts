import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedClaudeVersion, liveClaudeSessions } from './claude-sessions'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const record = (pid: number, fields: Record<string, unknown>) =>
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, ...fields }))

describe('liveClaudeSessions', () => {
  test('keys live records by conversation and skips dead pids and junk', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
    record(101, { sessionId: 'a', version: '2.1.283', status: 'busy', statusUpdatedAt: 5, startedAt: 1 })
    record(102, { sessionId: 'b', version: '2.1.299', status: 'idle', startedAt: 1 })
    writeFileSync(join(dir, '103.json'), '{not json')
    writeFileSync(join(dir, '104.abc.key'), 'x')
    const sessions = liveClaudeSessions(dir, pid => pid !== 102)
    expect([...sessions.keys()]).toEqual(['a'])
    expect(sessions.get('a')).toEqual({ pid: 101, version: '2.1.283', activity: 'busy', activitySince: 5, startedAt: 1 })
  })

  test('the newest live process wins for a resumed conversation', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
    record(201, { sessionId: 'a', version: '2.1.283', startedAt: 1 })
    record(202, { sessionId: 'a', version: '2.1.302', startedAt: 2 })
    expect(liveClaudeSessions(dir, () => true).get('a')?.version).toBe('2.1.302')
  })

  test('a missing directory is no sessions', () => {
    expect(liveClaudeSessions(join(tmpdir(), 'no-such-claude-sessions-dir')).size).toBe(0)
  })
})

describe('installedClaudeVersion', () => {
  test('reads the version directory the launcher resolves to', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-bin-'))
    mkdirSync(join(dir, 'versions'))
    writeFileSync(join(dir, 'versions', '2.1.302'), '')
    symlinkSync(join(dir, 'versions', '2.1.302'), join(dir, 'claude'))
    expect(installedClaudeVersion(join(dir, 'claude'))).toBe('2.1.302')
  })

  test('a launcher that is not a versioned install yields nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-bin-'))
    writeFileSync(join(dir, 'claude'), '')
    expect(installedClaudeVersion(join(dir, 'claude'))).toBeUndefined()
    expect(installedClaudeVersion(join(dir, 'missing'))).toBeUndefined()
  })
})
