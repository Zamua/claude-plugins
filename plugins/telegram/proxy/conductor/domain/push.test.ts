import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { StoredMessage } from './message'
import { PAYLOAD_LIMIT, approvalPush, messagePush, pushable } from './push'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'conductor-v1', name), 'utf8'))

const message = (over: Partial<StoredMessage> = {}): StoredMessage => ({
  id: 'msg_1', topic: '16832', seq: 42, author: 'agent', origin: 'proxy', kind: null, text: 'Running the suite now.',
  format: 'plain', blobs: [], replyTo: null, chatIds: [], at: '2026-11-01T20:25:37.123Z', editedAt: null,
  reactions: [], clientId: null, delivery: null, failure: null, ...over,
})

describe('the payloads match the contract fixtures', () => {
  test('push-message.json', () => {
    expect(messagePush(message(), 'build', 3).payload).toEqual(fixture('push-message.json'))
  })

  test('push-approval.json', () => {
    const push = approvalPush({ id: 'ap_7f3c', topic: '16832', prompt: 'Allow running `bun test`?' }, 'build')
    expect(push).toEqual({ payload: fixture('push-approval.json'), collapseId: 'ap_7f3c' })
  })
})

test('a long text is cut to fit 4 KB, never splitting a character', () => {
  const long = 'é€'.repeat(3000)
  const { payload } = messagePush(message({ text: long }), 'build', 1)
  const size = new TextEncoder().encode(JSON.stringify(payload)).length
  expect(size).toBeLessThanOrEqual(PAYLOAD_LIMIT)
  expect(size).toBeGreaterThan(PAYLOAD_LIMIT - 8)
  const body = (payload.aps as { alert: { body: string } }).alert.body
  expect(body.endsWith('…')).toBeTrue()
  expect(long.startsWith(body.slice(0, -1))).toBeTrue()
})

test('a reminder is time-sensitive in its category; an image alone says so', () => {
  const reminder = messagePush(message({ author: 'proxy', kind: 'reminder', text: '⏰ stretch' }), 'build', 0)
  expect(reminder.payload.aps).toMatchObject({ category: 'REMINDER', 'interruption-level': 'time-sensitive' })
  const blob = { id: 'b', mime: 'image/png', bytes: 1, width: null, height: null }
  expect((messagePush(message({ text: '', blobs: [blob] }), 'build', 0).payload.aps as { alert: { body: string } }).alert.body).toBe('[image]')
})

test('only agents\' and the proxy\'s new messages are pushed, never the operator\'s, an ask post or an edit', () => {
  expect(pushable(message())).toBeTrue()
  expect(pushable(message({ author: 'proxy', kind: 'reminder' }))).toBeTrue()
  expect(pushable(message({ author: 'operator', origin: 'app' }))).toBeFalse()
  expect(pushable(message({ author: 'proxy', kind: 'ask' }))).toBeFalse()
  expect(pushable(message({ editedAt: '2026-11-01T20:26:00.000Z' }))).toBeFalse()
})

test('a MarkdownV2 message is pushed as plain text', () => {
  const { payload } = messagePush(message({ text: 'Merged \\#98: *roles* \\(and projects\\)\\.', format: 'markdownv2' }), 'build', 0)
  expect((payload.aps as { alert: { body: string } }).alert.body).toBe('Merged #98: roles (and projects).')
})

