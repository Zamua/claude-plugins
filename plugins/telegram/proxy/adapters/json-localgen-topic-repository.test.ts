import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonLocalgenTopicRepository } from './json-localgen-topic-repository'
import { localgenTopic } from '../domain/localgen-topic'

describe('JSON localgen topic repository', () => {
  test('persists private, versioned harness state in the opencode-topics shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lg-topic-'))
    try {
      const file = join(dir, 'localgen-topics.json')
      const repository = new JsonLocalgenTopicRepository(file)
      repository.save(localgenTopic('9422', 'localgen', 10))

      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        version: 1,
        topics: [{ harness: 'localgen', topic: '9422', name: 'localgen', createdAt: 10, updatedAt: 10 }],
      })
      const reloaded = new JsonLocalgenTopicRepository(file)
      expect(reloaded.get('9422')?.harness).toBe('localgen')
      expect(reloaded.get('other')).toBeUndefined()
      expect(reloaded.list()).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses unsupported or corrupt state instead of silently dropping topics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lg-topic-'))
    try {
      const file = join(dir, 'localgen-topics.json')
      writeFileSync(file, JSON.stringify({ version: 2, topics: [] }))
      expect(() => new JsonLocalgenTopicRepository(file)).toThrow('unsupported localgen topic state')
      writeFileSync(file, JSON.stringify({ version: 1, topics: [{ harness: 'opencode' }] }))
      expect(() => new JsonLocalgenTopicRepository(file)).toThrow('invalid localgen topic state')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
