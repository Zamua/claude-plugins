import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonOpencodeTopicRepository } from './json-opencode-topic-repository'
import { opencodeTopic, withOpencodeSession } from '../domain/opencode-topic'

describe('JSON OpenCode topic repository', () => {
  test('persists private, versioned harness state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-topic-'))
    try {
      const file = join(dir, 'opencode-topics.json')
      const repository = new JsonOpencodeTopicRepository(file)
      repository.save(withOpencodeSession(opencodeTopic('42', 'pilot', 10), 'oc-pilot-42', 'ses_1', 20))

      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
      const reloaded = new JsonOpencodeTopicRepository(file)
      expect(reloaded.get('42')?.harness).toBe('opencode')
      expect(reloaded.get('42')?.opencodeSessionId).toBe('ses_1')
      expect(reloaded.list()).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses unsupported or corrupt state instead of silently dropping topics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-topic-'))
    try {
      const file = join(dir, 'opencode-topics.json')
      writeFileSync(file, JSON.stringify({ version: 2, topics: [] }))
      expect(() => new JsonOpencodeTopicRepository(file)).toThrow('unsupported OpenCode topic state')
      writeFileSync(file, JSON.stringify({ version: 1, topics: [{ harness: 'antigravity' }] }))
      expect(() => new JsonOpencodeTopicRepository(file)).toThrow('invalid OpenCode topic state')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
