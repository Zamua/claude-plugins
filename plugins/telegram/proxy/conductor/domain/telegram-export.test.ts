import { expect, test } from 'bun:test'
import { exportText, readExport } from './telegram-export'
import type { ExportMessage } from './telegram-export'

const OP = 'user1001'
const BOT = 'user2002'
const at = (n: number) => String(1_790_000_000 + n)
const msg = (id: number, over: Partial<ExportMessage> = {}): ExportMessage =>
  ({ id, type: 'message', date_unixtime: at(id), from_id: BOT, text: `m${id}`, ...over })
const root = (id: number, title: string): ExportMessage => ({ id, type: 'service', action: 'topic_created', title, date_unixtime: at(id) })
const options = { operatorId: '1001', topics: new Set(['general', '10']), exclude: new Set(['20']) }

test('a message belongs to the topic its reply chain reaches, or to general with no reply', () => {
  const { entries, skipped } = readExport([
    root(10, 'build'), root(20, 'square'),
    msg(11, { reply_to_message_id: 10 }), msg(12, { reply_to_message_id: 11 }), msg(13),
    msg(21, { reply_to_message_id: 20 }), msg(14, { reply_to_message_id: 999 }),
  ], options)
  expect(entries.map(e => [e.chatId, e.topic, e.replyToChatId])).toEqual([[11, '10', null], [12, '10', 11], [13, 'general', null]])
  expect(skipped).toMatchObject({ 'excluded topic': 1, 'no topic root': 1 })
})

test('who wrote it: the operator, the proxy by its notices, reminders and ask posts, or else an agent', () => {
  const texts = ['⏰ stretch', 'You asked: why?', '♻️ relaunching this topic', '↪️ asked @ops in #square', 'Done. Merged.']
  const { entries, skipped } = readExport([
    msg(1, { from_id: OP, text: 'go' }), ...texts.map((text, i) => msg(2 + i, { text })),
    msg(9, { text: 'You (app): hello' }),
  ], options)
  expect(entries.map(e => [e.author, e.kind])).toEqual([
    ['operator', null], ['proxy', 'reminder'], ['proxy', 'ask'], ['proxy', null], ['proxy', null], ['agent', null],
  ])
  expect(skipped).toMatchObject({ 'app echo': 1 })
})

test('more than one other sender needs the bot named, and anyone else is skipped', () => {
  const export_ = [msg(1), msg(2, { from_id: 'user3003' })]
  expect(() => readExport(export_, options)).toThrow('name the bot')
  expect(readExport(export_, { ...options, botId: '2002' }).skipped['unknown sender']).toBe(1)
})

test('a root that is no known topic is reported with its operator messages, not imported', () => {
  const { entries, unknownRoots } = readExport([
    root(30, 'old'), msg(31, { reply_to_message_id: 30, from_id: OP }), msg(32, { reply_to_message_id: 30 }), root(40, 'empty'),
  ], options)
  expect(entries).toEqual([])
  expect(unknownRoots).toEqual([
    { topic: '30', title: 'old', operatorMessages: 1, messages: 2 },
    { topic: '40', title: 'empty', operatorMessages: 0, messages: 0 },
  ])
})

test('times are UTC ISO, edits kept, and a photo or file is media with its type', () => {
  const [photo, file] = readExport([
    msg(1, { photo: 'photos/p.jpg', edited_unixtime: at(60) }), msg(2, { file: 'files/a.pdf', mime_type: 'application/pdf' }),
  ], options).entries
  expect(photo).toMatchObject({ at: new Date(Number(at(1)) * 1000).toISOString(), editedAt: new Date(Number(at(60)) * 1000).toISOString(), media: [{ path: 'photos/p.jpg', mime: 'image/jpeg' }] })
  expect(file.media).toEqual([{ path: 'files/a.pdf', mime: 'application/pdf' }])
})

test('text without markup stays plain; markup becomes MarkdownV2 with everything else escaped', () => {
  expect(exportText(['see ', { type: 'link', text: 'https://a.b/c' }, ' (ok).'])).toEqual({ text: 'see https://a.b/c (ok).', format: 'plain' })
  expect(exportText([
    { type: 'bold', text: 'Done.' }, ' ran ', { type: 'code', text: 'a`b' }, ' see ', { type: 'text_link', text: 'PR #9', href: 'https://x.y/(9)' },
    '\n', { type: 'pre', text: 'x = 1', language: 'py' }, '\n', { type: 'blockquote', text: 'one\ntwo' },
  ])).toEqual({
    text: '*Done\\.* ran `a\\`b` see [PR \\#9](https://x.y/(9\\))\n```py\nx = 1\n```\n>one\n>two',
    format: 'markdownv2',
  })
  expect(exportText(undefined)).toEqual({ text: '', format: 'plain' })
})
