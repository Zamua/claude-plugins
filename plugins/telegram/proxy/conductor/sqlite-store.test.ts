import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConductorStore } from './sqlite-store'

const open: ConductorStore[] = []
const store = (dir = mkdtempSync(join(tmpdir(), 'conductor-'))) => {
  const s = new ConductorStore(dir)
  open.push(s)
  return { s, dir }
}
afterEach(() => open.splice(0).forEach(s => s.close()))

const say = (topic: string, text: string) => ({ topic, text, author: 'agent' as const, origin: 'proxy' as const, format: 'plain' as const })

describe('ConductorStore', () => {
  test('numbers each topic\'s messages gaplessly, and every event with one cursor across topics', () => {
    const { s } = store()
    const a1 = s.append(say('general', 'one'))
    const b1 = s.append(say('42', 'two'))
    const a2 = s.append(say('general', 'three'))
    expect([a1.seq, b1.seq, a2.seq]).toEqual([1, 1, 2])
    expect(s.eventsAfter(0).map(e => [e.cursor, e.message.text])).toEqual([[1, 'one'], [2, 'two'], [3, 'three']])
    expect(s.eventsAfter(2).map(e => e.message.id)).toEqual([a2.id])
  })

  test('history pages newest first, before a seq', () => {
    const { s } = store()
    for (const text of ['a', 'b', 'c', 'd']) s.append(say('7', text))
    expect(s.history('7', 2).map(m => m.text)).toEqual(['d', 'c'])
    expect(s.history('7', 2, 3).map(m => m.text)).toEqual(['b', 'a'])
    expect(s.history('8', 10)).toEqual([])
  })

  test('a message keeps what it was given: author, origin, format, reply, chat ids, blobs', () => {
    const { s } = store()
    const first = s.append(say('7', 'first'))
    const blob = s.addBlob(new Uint8Array([1, 2, 3]), 'image/jpeg')
    const reply = s.append({ topic: '7', text: 'look', author: 'operator', origin: 'telegram', format: 'markdownv2', replyTo: first.id, chatIds: [501, 502], blobs: [blob], at: '2026-11-01T20:25:37.123Z' })
    expect(s.history('7', 1)[0]).toEqual({ ...reply })
    expect(reply).toMatchObject({ author: 'operator', origin: 'telegram', kind: null, format: 'markdownv2', replyTo: first.id, chatIds: [501, 502], at: '2026-11-01T20:25:37.123Z', editedAt: null, reactions: [] })
    expect(s.append({ ...say('7', '⏰ stretch'), author: 'proxy', kind: 'reminder' }).kind).toBe('reminder')
    expect(reply.blobs).toEqual([{ id: blob.id, mime: 'image/jpeg', bytes: 3, width: null, height: null }])
  })

  test('the same bytes are one blob, kept once on disk', () => {
    const { s, dir } = store()
    const a = s.addBlob(new Uint8Array([9, 9]), 'image/png')
    const b = s.addBlob(new Uint8Array([9, 9]), 'image/png')
    expect(a.id).toBe(b.id)
    expect(readdirSync(join(dir, 'blobs'))).toEqual([a.id])
  })

  test('what was stored is there after the store is opened again', () => {
    const { s, dir } = store()
    s.append(say('general', 'kept'))
    s.close()
    open.splice(open.indexOf(s), 1)
    const again = store(dir).s
    expect(again.history('general', 10).map(m => m.text)).toEqual(['kept'])
    expect(again.append(say('general', 'next')).seq).toBe(2)
  })
})

describe('ConductorStore, for the API', () => {
  test('each stored message is announced with its cursor, and the latest cursor follows', () => {
    const { s } = store()
    const seen: Array<[number, string]> = []
    s.onEvent(e => seen.push([e.cursor, e.message.text]))
    s.append(say('general', 'one'))
    s.append(say('42', 'two'))
    expect(seen).toEqual([[1, 'one'], [2, 'two']])
    expect(s.latestCursor()).toBe(2)
  })

  test('a topic\'s summary: its newest message, and unread messages that are not the operator\'s', () => {
    const { s } = store()
    s.append(say('7', 'agent says'))
    s.append({ ...say('7', 'operator says'), author: 'operator', origin: 'telegram' })
    s.append(say('7', 'agent again'))
    expect(s.summary('7')).toMatchObject({ unread: 2, readSeq: 0 })
    expect(s.summary('7').last?.text).toBe('agent again')
    expect(s.summary('none')).toEqual({ last: undefined, unread: 0, readSeq: 0 })
  })

  test('a device enrolls once per key, and keeps its node', () => {
    const { s } = store()
    const first = s.enroll({ name: 'iPhone', publicKey: 'KEY', nodeId: 'nPHONE', apnsToken: null, apnsEnv: 'sandbox' }, '2026-11-01T20:00:00.000Z')
    const again = s.enroll({ name: 'renamed', publicKey: 'KEY', nodeId: 'nOTHER', apnsToken: null, apnsEnv: null })
    expect(first.created).toBeTrue()
    expect(again).toEqual({ device: first.device, created: false })
    expect(s.device(first.device.id)).toMatchObject({ name: 'iPhone', nodeId: 'nPHONE', enrolledAt: '2026-11-01T20:00:00.000Z', lastSeen: null })
    s.touchDevice(first.device.id, '2026-11-01T21:00:00.000Z')
    expect(s.device(first.device.id)?.lastSeen).toBe('2026-11-01T21:00:00.000Z')
  })

  test('push targets are the devices with a token; a refused token is dropped only while it is current', () => {
    const { s } = store()
    const key = (n: number) => `BK${n}`
    const a = s.enroll({ name: 'phone', publicKey: key(1), nodeId: 'n1', apnsToken: 'aa', apnsEnv: 'sandbox' }).device
    s.enroll({ name: 'pad', publicKey: key(2), nodeId: 'n1', apnsToken: null, apnsEnv: null })
    expect(s.pushTargets().map(d => d.id)).toEqual([a.id])
    expect(s.setPush(a.id, 'bb', 'production')).toMatchObject({ apnsToken: 'bb', apnsEnv: 'production' })
    s.dropPushToken(a.id, 'aa')
    expect(s.device(a.id)?.apnsToken).toBe('bb')
    s.dropPushToken(a.id, 'bb')
    expect(s.pushTargets()).toEqual([])
  })

  test('unread counts other authors\' messages after each listed topic\'s marker', () => {
    const { s } = store()
    for (const text of ['a', 'b', 'c']) s.append(say('7', text))
    s.append({ ...say('7', 'mine'), author: 'operator' })
    s.append(say('8', 'x'))
    s.append(say('9', 'hidden'))
    s.markRead('7', 2)
    expect(s.unreadIn(['7', '8'])).toBe(2)
    expect(s.unreadIn([])).toBe(0)
  })
})
