import { describe, expect, test } from 'bun:test'
import { Bot } from 'grammy'
import type { ChatEvent } from '../chat/domain/inbound'
import { createTelegramInbound, telegramMessage, telegramSender } from './telegram-inbound'

const GROUP = -1007770000001
const chat = { id: GROUP, type: 'supergroup', title: 't', is_forum: true }
const operator = { id: 4242, is_bot: false, first_name: 'Op', username: 'op' }
const stranger = { id: 7, is_bot: false, first_name: 'S' }

describe('telegramMessage', () => {
  test('a topic message, with its sender, thread, time and reply', () => {
    const m = telegramMessage({
      message_id: 5, date: 1_700_000_000, chat, from: operator, message_thread_id: 42, text: 'hi',
      reply_to_message: { message_id: 3, text: 'earlier' },
    }, '4242')
    expect(m).toEqual({
      topic: '42', id: 5, chatId: String(GROUP), sender: { id: '4242', name: 'op', role: 'operator' },
      at: 1_700_000_000_000, text: 'hi', content: 'hi', replyTo: { id: 3, text: 'earlier' }, shape: 'text',
    })
  })

  test('General has no thread; a photo and a voice note carry their file refs', () => {
    const photo = telegramMessage({
      message_id: 6, date: 0, chat, from: stranger, caption: 'look',
      photo: [{ file_id: 'small', file_unique_id: 's' }, { file_id: 'big', file_unique_id: 'b' }],
    }, '4242')
    expect(photo).toMatchObject({ topic: 'general', caption: 'look', content: 'look', photo: { ref: 'big', uniqueRef: 'b' } })
    expect(photo.sender).toEqual({ id: '7', name: '7', role: 'member' })
    const voice = telegramMessage({ message_id: 7, date: 0, chat, from: operator, voice: { file_id: 'v', file_size: 9, mime_type: 'audio/ogg' } }, '4242')
    expect(voice.attachment).toEqual({ kind: 'voice', ref: 'v', size: 9, mime: 'audio/ogg', name: undefined })
    expect(voice.content).toBe('(voice message)')
  })

  test('a topic created or renamed is a service message with nothing to relay', () => {
    const created = telegramMessage({ message_id: 8, date: 0, chat, from: operator, message_thread_id: 9, forum_topic_created: { name: 'ask' } }, '4242')
    expect(created).toMatchObject({ service: { kind: 'created', name: 'ask' }, shape: 'forum_topic_created' })
    expect(created.content).toBeUndefined()
    const iconOnly = telegramMessage({ message_id: 9, date: 0, chat, from: operator, message_thread_id: 9, forum_topic_edited: {} }, '4242')
    expect(iconOnly.service).toEqual({ kind: 'renamed' })
  })
})

test('only the configured account is the operator, and only when one is configured', () => {
  expect(telegramSender({ id: 4242, username: 'op' }, '4242').role).toBe('operator')
  expect(telegramSender({ id: 4242 }, '').role).toBe('member')
  expect(telegramSender({ id: 7 }, '4242')).toEqual({ id: '7', name: '7', role: 'member' })
})

describe('createTelegramInbound', () => {
  function harness() {
    const bot = new Bot('123:fake', { botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'b' } as any })
    const sent: Array<{ method: string; payload: any }> = []
    bot.api.config.use(async (_prev, method, payload) => {
      sent.push({ method, payload })
      return { ok: true, result: true } as any
    })
    const events: ChatEvent[] = []
    let release = () => {}
    const logged: string[] = []
    const inbound = createTelegramInbound(bot, String(GROUP), '4242', line => void logged.push(line))
    inbound.listen(async event => {
      events.push(event)
      await new Promise<void>(r => (release = r))
    })
    return { bot, sent, events, logged, release: () => release() }
  }
  const message = (from: object, extra: object = {}) => ({ update_id: 1, message: { message_id: 5, date: 0, chat, from, text: 'hi', ...extra } })

  test('an update completes only once its event has been handled, so events arrive one at a time', async () => {
    const h = harness()
    let done = false
    const handled = h.bot.handleUpdate(message(operator) as any).then(() => { done = true })
    await Bun.sleep(20)
    expect(h.events.map(e => e.type)).toEqual(['message'])
    expect(done).toBeFalse()
    h.release()
    await handled
    expect(done).toBeTrue()
  })

  test('another chat is dropped, and its button presses refused, each with a log line naming the chat', async () => {
    const h = harness()
    await h.bot.handleUpdate(message(operator, { chat: { ...chat, id: -1001 } }) as any)
    await h.bot.handleUpdate({ update_id: 2, callback_query: { id: 'q', from: operator, chat_instance: '1', data: 'tgroute:dismiss', message: { message_id: 9, date: 0, chat: { ...chat, id: -1001 }, text: 'x' } } } as any)
    expect(h.events).toEqual([])
    expect(h.sent).toEqual([{ method: 'answerCallbackQuery', payload: { callback_query_id: 'q', text: 'Not authorized.' } }])
    expect(h.logged).toEqual([
      'dropped a message from chat -1001 (supergroup): only the group is relayed',
      'refused a button press from chat -1001: only the group is relayed',
    ])
  })

  test('a button press carries its intent, topic, presser and message text', async () => {
    const h = harness()
    const pressed = h.bot.handleUpdate({ update_id: 3, callback_query: { id: 'q', from: stranger, chat_instance: '1', data: 'tgperm:allow:r1', message: { message_id: 9, date: 0, chat, message_thread_id: 48, text: '🔐 Permission: Bash' } } } as any)
    await Bun.sleep(20)
    const event = h.events[0]
    expect(event.type).toBe('action')
    if (event.type !== 'action') return
    expect(event.press).toMatchObject({ intent: { kind: 'permission', behavior: 'allow', requestId: 'r1' }, topic: '48', text: '🔐 Permission: Bash', sender: { id: '7', role: 'member' } })
    h.release()
    await pressed
  })
})
