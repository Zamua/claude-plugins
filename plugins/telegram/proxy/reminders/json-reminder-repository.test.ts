import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonReminderRepository } from './json-reminder-repository'
import type { Reminder } from './domain/reminder'

const reminder = (id: string, topic = '7044'): Reminder => ({
  id,
  topic,
  at: 1_800_000_000_000,
  atText: '2027-01-15T08:00:00-05:00',
  text: `reminder ${id}`,
  createdAt: 1_790_000_000_000,
})

const fresh = () => join(mkdtempSync(join(tmpdir(), 'reminders-')), 'reminders.json')

describe('JsonReminderRepository', () => {
  test('survives a reload, which is the point of keeping reminders in the proxy', () => {
    const file = fresh()
    const repo = new JsonReminderRepository(file)
    repo.add(reminder('a'))
    repo.add(reminder('b', 'general'))
    expect(new JsonReminderRepository(file).list().map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  test('removes by id and persists the removal', () => {
    const file = fresh()
    const repo = new JsonReminderRepository(file)
    repo.add(reminder('a'))
    expect(repo.remove('a')).toBeTrue()
    expect(repo.remove('a')).toBeFalse()
    expect(new JsonReminderRepository(file).list()).toEqual([])
  })

  test('writes the file owner-only', () => {
    const file = fresh()
    new JsonReminderRepository(file).add(reminder('a'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })

  test('refuses a file in an unknown format instead of silently dropping reminders', () => {
    const file = fresh()
    writeFileSync(file, JSON.stringify({ version: 9, reminders: [] }))
    expect(() => new JsonReminderRepository(file)).toThrow(/unsupported/)
  })
})
