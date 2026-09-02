import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonAntigravityTopicRepository } from './json-antigravity-topic-repository'
import { antigravityRoute, antigravityTopic } from '../domain/antigravity-topic'

describe('JSON Antigravity topic repository', () => {
  test('persists private, versioned harness state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-topic-'))
    try {
      const file = join(dir, 'topics.json')
      const repository = new JsonAntigravityTopicRepository(file)
      repository.save(antigravityTopic('42', 'pilot', antigravityRoute({
        id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash',
        variants: { medium: 'gemini-3.8-flash-medium' },
        efforts: ['medium'], defaultEffort: 'medium',
      }, 'medium'), 10))

      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
      expect(new JsonAntigravityTopicRepository(file).get('42')?.harness).toBe('antigravity')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
