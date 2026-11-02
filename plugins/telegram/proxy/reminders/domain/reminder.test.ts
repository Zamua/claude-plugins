import { describe, expect, test } from 'bun:test'
import {
  LATE_AFTER_MS,
  MAX_AHEAD_MS,
  dueReminders,
  reminderNotice,
  scheduleReminder,
  type Reminder,
} from './reminder'

const NOW = Date.parse('2026-10-24T22:00:00Z')

const make = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  topic: '7044',
  at: NOW + 60_000,
  atText: '2026-10-24T18:01:00-04:00',
  text: 'check the flight',
  createdAt: NOW,
  ...over,
})

describe('scheduleReminder', () => {
  test('accepts a future time with an explicit offset', () => {
    const r = scheduleReminder({ topic: '7044', at: '2026-10-26T09:03:00-04:00', text: 'check the flight' }, NOW, 'abc')
    expect(r).toEqual({
      id: 'abc',
      topic: '7044',
      at: Date.parse('2026-10-26T13:03:00Z'),
      atText: '2026-10-26T09:03:00-04:00',
      text: 'check the flight',
      createdAt: NOW,
    })
  })

  test('a quiet reminder is marked quiet; anything but true is a normal one', () => {
    const at = '2026-10-26T13:03:00Z'
    expect(scheduleReminder({ topic: '7', at, text: 'start', quiet: true }, NOW, 'q').quiet).toBeTrue()
    expect(scheduleReminder({ topic: '7', at, text: 'start', quiet: 'yes' }, NOW, 'q').quiet).toBeUndefined()
  })

  test('keeps an optional prompt for the topic agent', () => {
    const r = scheduleReminder({ topic: 'general', at: '2026-10-26T13:03:00Z', text: 't', prompt: 'search Gmail first' }, NOW, 'x')
    expect(r).toMatchObject({ prompt: 'search Gmail first' })
  })

  test('rejects a time without a zone, since the proxy clock is not the operator clock', () => {
    expect(() => scheduleReminder({ topic: '1', at: '2026-10-26T09:03:00', text: 't' }, NOW, 'x')).toThrow(/offset/)
  })

  test('rejects unparseable, past and too-distant times', () => {
    expect(() => scheduleReminder({ topic: '1', at: 'monday 9am', text: 't' }, NOW, 'x')).toThrow()
    expect(() => scheduleReminder({ topic: '1', at: '2026-10-24T21:00:00Z', text: 't' }, NOW, 'x')).toThrow(/past/)
    const tooFar = new Date(NOW + MAX_AHEAD_MS + 86_400_000).toISOString()
    expect(() => scheduleReminder({ topic: '1', at: tooFar, text: 't' }, NOW, 'x')).toThrow(/ahead/)
  })

  test('rejects a missing topic or empty and oversized text', () => {
    const at = '2026-10-26T13:03:00Z'
    expect(() => scheduleReminder({ at, text: 't' }, NOW, 'x')).toThrow(/topic/)
    expect(() => scheduleReminder({ topic: '1', at, text: '  ' }, NOW, 'x')).toThrow(/text/)
    expect(() => scheduleReminder({ topic: '1', at, text: 'x'.repeat(1001) }, NOW, 'x')).toThrow(/text/)
    expect(() => scheduleReminder({ topic: '1', at, text: 't', prompt: 'x'.repeat(4001) }, NOW, 'x')).toThrow(/prompt/)
  })
})

describe('dueReminders', () => {
  test('returns only reminders at or before now, earliest first', () => {
    const list = [make({ id: 'late', at: NOW }), make({ id: 'future', at: NOW + 1 }), make({ id: 'early', at: NOW - 5 })]
    expect(dueReminders(list, NOW).map(r => r.id)).toEqual(['early', 'late'])
  })
})

describe('reminderNotice', () => {
  test('a quiet reminder posted nothing, and its agent reports to general', () => {
    const n = reminderNotice(make({ quiet: true, prompt: 'start the migration' }), NOW + 60_000)
    expect(n).toMatch(/quiet reminder .* is due \("check the flight"\); nothing was posted in this topic/)
    expect(n).toContain('Instructions: start the migration')
    expect(n).toMatch(/do not post in this topic\. Report to the general session with SendMessage\.$/)
  })

  test('says no reply is needed when there is no follow-up prompt', () => {
    const n = reminderNotice(make(), NOW + 60_000)
    expect(n).toContain('check the flight')
    expect(n).toContain('No reply is required')
    expect(n).not.toContain('late')
  })

  test('asks for follow-up work when a prompt is set', () => {
    const n = reminderNotice(make({ prompt: 'search Gmail for 2PO4Q2' }), NOW + 60_000)
    expect(n).toContain('search Gmail for 2PO4Q2')
    expect(n).not.toContain('No reply is required')
  })

  test('flags a reminder that fires late, as after a proxy outage', () => {
    const r = make()
    expect(reminderNotice(r, r.at + LATE_AFTER_MS + 60_000)).toMatch(/late/)
  })
})
