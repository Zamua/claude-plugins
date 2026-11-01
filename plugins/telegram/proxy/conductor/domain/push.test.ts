import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { StoredMessage } from './message'
import { CAPTION_WINDOW_MS, PAYLOAD_LIMIT, approvalPush, attachmentLabel, captionOf, messagePush, pushable } from './push'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'conductor-v1', name), 'utf8'))

const photo = { id: 'blob_9a1', mime: 'image/png', bytes: 1, width: null, height: null }
const message = (over: Partial<StoredMessage> = {}): StoredMessage => ({
  id: 'msg_1', topic: '16832', seq: 42, author: 'agent', origin: 'proxy', kind: null, text: 'Running the suite now.',
  format: 'plain', blobs: [], replyTo: null, chatIds: [], at: '2026-11-01T20:25:37.123Z', editedAt: null,
  reactions: [], clientId: null, delivery: null, failure: null, imported: false, ...over,
})

describe('the payloads match the contract fixtures', () => {
  test('push-message.json', () => {
    expect(messagePush(message(), 'build', 3)).toEqual({ payload: fixture('push-message.json'), collapseId: 'msg_1' })
  })

  test('push-media.json', () => {
    const media = message({ id: 'msg_2', seq: 43, text: '', blobs: [photo], at: '2026-11-01T20:25:38.000Z' })
    expect(messagePush(media, 'build', 4, message())).toEqual({ payload: fixture('push-media.json'), collapseId: 'msg_1' })
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

test('a reminder is time-sensitive in its category', () => {
  const reminder = messagePush(message({ author: 'proxy', kind: 'reminder', text: '⏰ stretch' }), 'build', 0)
  expect(reminder.payload.aps).toMatchObject({ category: 'REMINDER', 'interruption-level': 'time-sensitive' })
})

test('attachments alone are named as Messages names them, and the first is named for the extension', () => {
  const pdf = { ...photo, id: 'blob_pdf', mime: 'application/pdf' }
  expect([[photo], [photo, photo], [pdf], [photo, pdf]].map(attachmentLabel)).toEqual(['Photo', '2 Photos', 'Attachment', '2 Attachments'])
  const { payload } = messagePush(message({ text: '', blobs: [photo, pdf] }), 'build', 0)
  expect(payload).toMatchObject({ aps: { alert: { body: '2 Attachments' }, sound: 'default' }, blob: 'blob_9a1' })
})

test('a lone attachment belongs to the same author\'s text just before it in its topic', () => {
  const text = message()
  const media = (over: Partial<StoredMessage> = {}) =>
    message({ id: 'msg_2', text: '', blobs: [photo], at: new Date(Date.parse(text.at) + CAPTION_WINDOW_MS).toISOString(), ...over })
  expect(captionOf(media(), text)).toBe(text)
  expect(captionOf(media(), undefined)).toBeUndefined()
  expect(captionOf(media({ at: new Date(Date.parse(text.at) + CAPTION_WINDOW_MS + 1).toISOString() }), text)).toBeUndefined()
  expect(captionOf(media({ author: 'proxy' }), text)).toBeUndefined()
  expect(captionOf(media({ topic: '9' }), text)).toBeUndefined()
  expect(captionOf(media({ text: 'own caption' }), text)).toBeUndefined()
  expect(captionOf(media(), message({ text: '', blobs: [photo] }))).toBeUndefined()
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

