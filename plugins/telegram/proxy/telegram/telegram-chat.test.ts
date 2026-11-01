import { describe, expect, test } from 'bun:test'
import { InputFile } from 'grammy'
import type { MessageId } from '../chat/domain/chat-port'
import { createTelegramChat } from './telegram-chat'

type Call = { method: string; args: unknown[] }

// Records every Bot API call as the adapter made it; each send answers with the next id.
function fakeApi(answers: Record<string, unknown> = {}) {
  const calls: Call[] = []
  let next = 500
  const api = new Proxy({}, {
    get: (_, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args })
      if (method in answers) return answers[method]
      if (method === 'createForumTopic') return { message_thread_id: 77 }
      return { message_id: next++ }
    },
  })
  return { api: api as Parameters<typeof createTelegramChat>[0], calls }
}

const CHAT = '-1007770000001'
const downloads: string[] = []
const chatOver = (answers?: Record<string, unknown>) => {
  const fake = fakeApi(answers)
  return { ...fake, chat: createTelegramChat(fake.api, CHAT, async ref => (downloads.push(ref), `/inbox/${ref}`)) }
}
const id = (n: number) => n as MessageId

describe('send', () => {
  test('puts text in the topic thread, and General in none', async () => {
    const { chat, calls } = chatOver()
    expect(await chat.send('42', { text: 'hello' })).toEqual([id(500)])
    await chat.send('general', { text: 'hi' })
    expect(calls).toEqual([
      { method: 'sendMessage', args: [CHAT, 'hello', { message_thread_id: 42 }] },
      { method: 'sendMessage', args: [CHAT, 'hi', {}] },
    ])
  })

  test('splits at 4096 characters, the reply only on the first part, MarkdownV2 on each', async () => {
    const { chat, calls } = chatOver()
    const ids = await chat.send('42', { text: 'a'.repeat(5000), format: 'markdown', replyTo: id(9) })
    expect(ids).toEqual([id(500), id(501)])
    expect(calls.map(c => [(c.args[1] as string).length, c.args[2]])).toEqual([
      [4096, { message_thread_id: 42, reply_parameters: { message_id: 9 }, parse_mode: 'MarkdownV2' }],
      [904, { message_thread_id: 42, parse_mode: 'MarkdownV2' }],
    ])
  })

  test('a forced reply opens the reply box with its placeholder', async () => {
    const { chat, calls } = chatOver()
    await chat.send('42', { text: 'name?', forceReply: { placeholder: 'secret name' } })
    expect(calls[0].args[2]).toEqual({
      message_thread_id: 42,
      reply_markup: { force_reply: true, input_field_placeholder: 'secret name' },
    })
  })
})

describe('sendFile', () => {
  test('a photo or a document, in the thread, with its reply and caption', async () => {
    const { chat, calls } = chatOver()
    expect(await chat.sendFile('42', { file: { path: '/tmp/a.png' }, kind: 'photo', caption: 'You asked: x', replyTo: id(3) }))
      .toBe(id(500))
    await chat.sendFile('general', { file: { bytes: new Uint8Array([1]), name: 'a.png' }, kind: 'document' })
    expect(calls.map(c => [c.method, c.args[0], c.args[1] instanceof InputFile, c.args[2]])).toEqual([
      ['sendPhoto', CHAT, true, { message_thread_id: 42, reply_parameters: { message_id: 3 }, caption: 'You asked: x' }],
      ['sendDocument', CHAT, true, {}],
    ])
  })
})

describe('the rest of the port', () => {
  test('edit passes MarkdownV2 only when asked, and keeps the id when Telegram answers true', async () => {
    const { chat, calls } = chatOver({ editMessageText: true })
    expect(await chat.edit(id(7), 'plain')).toBe(id(7))
    await chat.edit(id(7), '*bold*', 'markdown')
    expect(calls.map(c => c.args)).toEqual([[CHAT, 7, 'plain'], [CHAT, 7, '*bold*', { parse_mode: 'MarkdownV2' }]])
  })

  test('delete, react, typing, topics and the command menu are the group\'s', async () => {
    const { chat, calls } = chatOver({ deleteMessage: true, setMessageReaction: true, sendChatAction: true, setMyCommands: true })
    await chat.delete(id(7))
    await chat.react(id(7), '👍')
    await chat.typing('42', 'text')
    await chat.typing('general', 'upload')
    expect(await chat.createTopic('ask')).toBe('77')
    await chat.setCommands([{ command: 'relaunch', description: 'r' }])
    expect(calls).toEqual([
      { method: 'deleteMessage', args: [CHAT, 7] },
      { method: 'setMessageReaction', args: [CHAT, 7, [{ type: 'emoji', emoji: '👍' }]] },
      { method: 'sendChatAction', args: [CHAT, 'typing', { message_thread_id: 42 }] },
      { method: 'sendChatAction', args: [CHAT, 'upload_photo', {}] },
      { method: 'createForumTopic', args: [CHAT, 'ask'] },
      { method: 'setMyCommands', args: [[{ command: 'relaunch', description: 'r' }], { scope: { type: 'chat', chat_id: -1007770000001 } }] },
    ])
  })

  test('download goes to the downloader it was given', async () => {
    const { chat } = chatOver()
    expect(await chat.download('file-1')).toBe('/inbox/file-1')
    expect(downloads).toContain('file-1')
  })

  test('a held id names a message only when it is a positive integer', () => {
    const { chat } = chatOver()
    expect(chat.messageId(12)).toBe(id(12))
    expect(chat.messageId('12')).toBe(id(12))
    for (const raw of [0, -1, 1.5, '12a', '', null, undefined, {}]) expect(chat.messageId(raw)).toBeUndefined()
  })

  test('links a message in its topic', () => {
    expect(chatOver().chat.link('78', id(16901))).toBe('https://t.me/c/7770000001/78/16901')
  })

  test('says what Telegram can do', () => {
    expect(chatOver().chat.capabilities).toMatchObject({ buttons: true, maxMessageLength: 4096, markdown: 'telegram-markdownv2' })
  })
})
