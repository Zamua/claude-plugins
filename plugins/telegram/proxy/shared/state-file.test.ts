import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonTopicRepository } from '../harness/json-topic-repository'
import { opencodeTopic, opencodeTopicFromRecord } from '../harness/opencode/domain/opencode-topic'
import type { OpencodeTopic } from '../harness/opencode/domain/opencode-topic'
import { JsonReminderRepository } from '../reminders/json-reminder-repository'
import { openOrSetAside } from './state-file'

let locked: string | undefined
afterEach(() => {
  if (locked) chmodSync(locked, 0o700)
  locked = undefined
})

const fresh = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'state-file-'))
  return { dir, file: join(dir, name) }
}
const opencode = (file: string) => () => new JsonTopicRepository<OpencodeTopic>(file, 'OpenCode', opencodeTopicFromRecord)

describe('openOrSetAside', () => {
  test('an unreadable harness file keeps its bytes through the open-then-save cycle', () => {
    const { dir, file } = fresh('opencode-topics.json')
    const corrupt = '{"version":1,"topics":[{"harness":"opencode","topic":"42"'
    writeFileSync(file, corrupt)
    const lines: string[] = []

    const repository = openOrSetAside('OpenCode topics', file, opencode(file), m => lines.push(m), 1234)
    repository.save(opencodeTopic('7', 'fresh', 1))

    expect(repository.list().map(t => t.topic)).toEqual(['7'])
    expect(readFileSync(join(dir, 'opencode-topics.json.unreadable-1234'), 'utf8')).toBe(corrupt)
    expect(lines.join('\n')).toContain('opencode-topics.json.unreadable-1234')
  })

  test('a file in a format the repository refuses is set aside too', () => {
    const { dir, file } = fresh('reminders.json')
    writeFileSync(file, JSON.stringify({ version: 9, reminders: [] }))
    const reminders = openOrSetAside('reminders', file, () => new JsonReminderRepository(file), () => {}, 5)
    expect(reminders.list()).toEqual([])
    expect(readdirSync(dir).sort()).toEqual(['reminders.json.unreadable-5'])
  })

  test('a readable or missing file opens as it is', () => {
    const { file } = fresh('opencode-topics.json')
    const lines: string[] = []
    openOrSetAside('OpenCode topics', file, opencode(file), m => lines.push(m)).save(opencodeTopic('42', 'kept', 1))
    expect(openOrSetAside('OpenCode topics', file, opencode(file), m => lines.push(m)).get('42')?.name).toBe('kept')
    expect(lines).toEqual([])
  })

  test('refuses to continue when an unreadable file cannot be moved aside', () => {
    const { dir, file } = fresh('opencode-topics.json')
    writeFileSync(file, 'not json')
    chmodSync(dir, 0o500)
    locked = dir
    expect(() => openOrSetAside('OpenCode topics', file, opencode(file), () => {})).toThrow(/could not be moved aside/)
    chmodSync(dir, 0o700)
    locked = undefined
    expect(readFileSync(file, 'utf8')).toBe('not json')
  })
})
