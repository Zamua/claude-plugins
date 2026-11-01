import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DELETE_WINDOW_MS } from './domain/sent-messages'
import { JsonSentMessages } from './json-sent-messages'

const file = () => join(mkdtempSync(join(tmpdir(), 'sent-')), 'sent-messages.json')

test('what a topic sent survives a restart, owner-only on disk, and a deleted one is forgotten', () => {
  const f = file()
  let now = 1_000
  const first = new JsonSentMessages(f, () => now)
  first.record('42', [500, 501])
  expect(statSync(f).mode & 0o777).toBe(0o600)
  const again = new JsonSentMessages(f, () => now)
  expect(again.sentBy('42', 501)).toBeTrue()
  expect(again.sentBy('43', 501)).toBeFalse()
  again.forget('42', 501)
  expect(new JsonSentMessages(f, () => now).sentBy('42', 501)).toBeFalse()
})

test('messages past the delete window are dropped from the file', () => {
  const f = file()
  let now = 1_000
  const store = new JsonSentMessages(f, () => now)
  store.record('42', [500])
  now += DELETE_WINDOW_MS
  store.record('42', [600])
  expect(JSON.parse(readFileSync(f, 'utf8')).messages.map((m: { id: number }) => m.id)).toEqual([600])
})

test('a file it cannot trust is refused rather than half read', () => {
  const f = file()
  writeFileSync(f, JSON.stringify({ version: 1, messages: [{ topic: '42', id: 'x', at: 1 }] }))
  expect(() => new JsonSentMessages(f)).toThrow()
})
