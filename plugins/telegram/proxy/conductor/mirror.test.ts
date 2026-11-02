import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatPort, MessageId } from '../chat/domain/chat-port'
import type { InboundMsg } from '../topics/state'
import type { NewMessage } from './domain/message'
import { formatOf, mirroredChat, recordingOperatorTurns } from './mirror'
import type { MessageLog } from './mirror'

const id = (n: number) => n as MessageId

function fakeChat(fail = false) {
  const sent: string[] = []
  let next = 100
  const chat = {
    capabilities: { markdown: 'telegram-markdownv2' },
    async send(_topic: string, message: { text: string }) {
      if (fail) throw new Error('Telegram refused it')
      sent.push(message.text)
      return [id(next++), id(next++)]
    },
    async sendFile() {
      return id(next++)
    },
    async react() {},
  } as unknown as ChatPort
  return { chat, sent }
}

function fakeLog(failing = false) {
  const appended: NewMessage[] = []
  const log: MessageLog = {
    append(message) {
      if (failing) throw new Error('disk full')
      appended.push(message)
      return { ...message, id: 'm', seq: appended.length } as never
    },
    addBlob: (bytes, mime) => ({ id: `blob_${bytes.length}`, mime, bytes: bytes.length, width: null, height: null }),
  }
  return { log, appended }
}

describe('mirroredChat', () => {
  test('a text it sends is stored once, whole, with every part\'s chat id and the format as written', async () => {
    const { chat } = fakeChat()
    const { log, appended } = fakeLog()
    const ids = await mirroredChat(chat, log, { author: 'agent' }, () => {}).send('42', { text: '*done*', format: 'markdown' })
    expect(ids).toEqual([id(100), id(101)])
    expect(appended).toEqual([{ topic: '42', text: '*done*', format: 'markdownv2', chatIds: [100, 101], author: 'agent', origin: 'proxy', kind: null }])
  })

  test('a file is stored as a blob with its caption, as the kind it was wired for', async () => {
    const { chat } = fakeChat()
    const { log, appended } = fakeLog()
    const path = join(mkdtempSync(join(tmpdir(), 'mirror-')), 'shot.png')
    writeFileSync(path, new Uint8Array([1, 2, 3, 4]))
    await mirroredChat(chat, log, { author: 'proxy', kind: 'ask' }, () => {}).sendFile('7', { file: { path }, kind: 'photo', caption: 'You asked: why' })
    expect(appended[0]).toMatchObject({ topic: '7', text: 'You asked: why', author: 'proxy', kind: 'ask', chatIds: [100] })
    expect(appended[0].blobs).toEqual([{ id: 'blob_4', mime: 'image/png', bytes: 4, width: null, height: null }])
  })

  test('a send that fails stores nothing, and a store that fails never fails the send', async () => {
    const failing = fakeLog()
    await expect(mirroredChat(fakeChat(true).chat, failing.log, { author: 'agent' }, () => {}).send('1', { text: 'x' })).rejects.toThrow()
    expect(failing.appended).toEqual([])
    const reports: unknown[] = []
    const { chat, sent } = fakeChat()
    await mirroredChat(chat, fakeLog(true).log, { author: 'agent' }, e => reports.push(e)).send('1', { text: 'still sent' })
    expect(sent).toEqual(['still sent'])
    expect(reports).toHaveLength(1)
  })

  test('everything else reaches the chat unchanged', async () => {
    const { chat } = fakeChat()
    expect(await mirroredChat(chat, fakeLog().log, { author: 'agent' }, () => {}).react(id(5), '👀')).toBeUndefined()
  })
})

test('formats are named as the app renders them', () => {
  expect(formatOf('markdown', 'telegram-markdownv2')).toBe('markdownv2')
  expect(formatOf('markdown', 'commonmark')).toBe('markdown')
  expect(formatOf(undefined, 'telegram-markdownv2')).toBe('plain')
  expect(formatOf('gfm', 'telegram-markdownv2')).toBe('markdown')
})

describe('recordingOperatorTurns', () => {
  const turn = (meta: Record<string, string>, content = 'hello'): InboundMsg => ({ content, meta } as InboundMsg)

  test('an operator turn is stored, with its photo, before it is queued', () => {
    const { log, appended } = fakeLog()
    const order: string[] = []
    const image = join(mkdtempSync(join(tmpdir(), 'turn-')), 'p.jpg')
    writeFileSync(image, new Uint8Array([7, 7, 7]))
    const enqueue = recordingOperatorTurns(() => order.push(`queued ${appended.length}`), log, '4242', () => {})
    enqueue('42', turn({ user_id: '4242', message_id: '901', ts: '2026-11-01T20:25:37.123Z', image_path: image }, 'look at this'))
    expect(order).toEqual(['queued 1'])
    expect(appended[0]).toMatchObject({ topic: '42', author: 'operator', origin: 'telegram', text: 'look at this', chatIds: [901], at: '2026-11-01T20:25:37.123Z' })
    expect(appended[0].blobs).toEqual([{ id: 'blob_3', mime: 'image/jpeg', bytes: 3, width: null, height: null }])
  })

  test('a turn the proxy made, or a member\'s, is queued and never stored as the operator\'s', () => {
    const { log, appended } = fakeLog()
    const queued: string[] = []
    const enqueue = recordingOperatorTurns((_t, m) => queued.push(m.content), log, '4242', () => {})
    enqueue('42', turn({ user_id: '' }, 'SYSTEM NOTICE'))
    enqueue('42', turn({ user_id: '777' }, 'from a member'))
    expect(queued).toEqual(['SYSTEM NOTICE', 'from a member'])
    expect(appended).toEqual([])
    const unset = fakeLog()
    recordingOperatorTurns(() => {}, unset.log, '', () => {})('42', turn({ user_id: '' }))
    expect(unset.appended).toEqual([])
  })
})
