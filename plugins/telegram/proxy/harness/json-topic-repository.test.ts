import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonTopicRepository } from './json-topic-repository'
import { antigravityRoute, antigravityTopic, antigravityTopicFromRecord } from './antigravity/domain/antigravity-topic'
import type { AntigravityTopic } from './antigravity/domain/antigravity-topic'
import { localgenTopic, localgenTopicFromRecord } from './localgen/domain/localgen-topic'
import type { LocalgenTopic } from './localgen/domain/localgen-topic'
import { opencodeTopic, opencodeTopicFromRecord, withOpencodeSession } from './opencode/domain/opencode-topic'
import type { OpencodeTopic } from './opencode/domain/opencode-topic'

const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'topic-repo-')), name)
const opencode = (file: string) => new JsonTopicRepository<OpencodeTopic>(file, 'OpenCode', opencodeTopicFromRecord)
const localgen = (file: string) => new JsonTopicRepository<LocalgenTopic>(file, 'localgen', localgenTopicFromRecord)
const antigravity = (file: string) =>
  new JsonTopicRepository<AntigravityTopic>(file, 'Antigravity', antigravityTopicFromRecord)

describe('JsonTopicRepository', () => {
  test('persists private, versioned state in the shared topics shape', () => {
    const file = fresh('localgen-topics.json')
    localgen(file).save(localgenTopic('9422', 'localgen', 10))

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      topics: [{ harness: 'localgen', topic: '9422', name: 'localgen', createdAt: 10, updatedAt: 10 }],
    })
    const reloaded = localgen(file)
    expect(reloaded.get('9422')?.harness).toBe('localgen')
    expect(reloaded.get('other')).toBeUndefined()
    expect(reloaded.list()).toHaveLength(1)
  })

  test('an OpenCode topic keeps its session id across a reload', () => {
    const file = fresh('opencode-topics.json')
    opencode(file).save(withOpencodeSession(opencodeTopic('42', 'pilot', 10), 'oc-pilot-42', 'ses_1', 20))
    const reloaded = opencode(file)
    expect(reloaded.get('42')?.harness).toBe('opencode')
    expect(reloaded.get('42')?.opencodeSessionId).toBe('ses_1')
  })

  test('an Antigravity topic keeps its route across a reload', () => {
    const file = fresh('antigravity-topics.json')
    const route = antigravityRoute({
      id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash',
      variants: { medium: 'gemini-3.8-flash-medium' },
      efforts: ['medium'], defaultEffort: 'medium',
    }, 'medium')
    antigravity(file).save(antigravityTopic('42', 'pilot', route, 10))
    const reloaded = antigravity(file).get('42')
    expect(reloaded?.harness).toBe('antigravity')
    expect(reloaded?.route).toEqual(route)
  })

  test('callers cannot mutate stored topics through returned or saved objects', () => {
    const file = fresh('opencode-topics.json')
    const repository = opencode(file)
    const topic = opencodeTopic('42', 'pilot', 10)
    repository.save(topic)
    topic.name = 'changed after save'
    repository.get('42')!.name = 'changed after get'
    expect(repository.get('42')?.name).toBe('pilot')
  })

  test('refuses unsupported or corrupt state instead of silently dropping topics', () => {
    const file = fresh('opencode-topics.json')
    writeFileSync(file, JSON.stringify({ version: 2, topics: [] }))
    expect(() => opencode(file)).toThrow('unsupported OpenCode topic state')
    writeFileSync(file, 'null')
    expect(() => opencode(file)).toThrow('unsupported OpenCode topic state')
    writeFileSync(file, JSON.stringify({ version: 1, topics: [{ harness: 'antigravity' }] }))
    expect(() => opencode(file)).toThrow('invalid OpenCode topic state')
    writeFileSync(file, JSON.stringify({ version: 1, topics: [{ harness: 'opencode' }] }))
    expect(() => localgen(file)).toThrow('invalid localgen topic state')
  })
})
