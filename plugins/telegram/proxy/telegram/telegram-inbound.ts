// The chat's inbound side over the Bot API: updates from the one forum group,
// turned into chat events with a verified sender. grammy runs one update at a
// time and each handler is awaited, so events are delivered in order, one at a time.
import type { Bot } from 'grammy'
import type { MessageId } from '../chat/domain/chat-port'
import type { ChatEvent, ChatInbound, ChatMessage, Sender } from '../chat/domain/inbound'
import { createPolling } from './polling'
import { decodeCallback } from './telegram-callback'
import { telegramActionPress } from './telegram-chat'
import { describeMessage } from './telegram-messages'

const TRACED = ['text', 'photo', 'document', 'voice', 'sticker', 'location', 'venue', 'forum_topic_created', 'forum_topic_edited']

const topicOf = (message: { message_thread_id?: number } | undefined) =>
  message?.message_thread_id != null ? String(message.message_thread_id) : 'general'

/** Telegram authenticates the sender; the operator is the one configured account id. */
export function telegramSender(from: { id: number; username?: string } | undefined, operatorId: string): Sender {
  const id = String(from?.id ?? '')
  return { id, name: from?.username ?? id, role: operatorId !== '' && id === operatorId ? 'operator' : 'member' }
}

export function telegramMessage(msg: any, operatorId: string): ChatMessage {
  const described = describeMessage(msg)
  const a = described?.attachment
  const parent = msg.reply_to_message
  return {
    topic: topicOf(msg),
    id: msg.message_id as MessageId,
    chatId: String(msg.chat.id),
    sender: telegramSender(msg.from, operatorId),
    at: (msg.date ?? 0) * 1000,
    ...(typeof msg.text === 'string' ? { text: msg.text } : {}),
    ...(typeof msg.caption === 'string' ? { caption: msg.caption } : {}),
    ...(described ? { content: described.content } : {}),
    ...(described?.photo ? { photo: { ref: described.photo.file_id, uniqueRef: described.photo.file_unique_id } } : {}),
    ...(a ? { attachment: { kind: a.kind, ref: a.file_id, size: a.size, mime: a.mime, name: a.name } } : {}),
    ...(parent ? { replyTo: { id: parent.message_id as MessageId, text: String(parent.text ?? '') } } : {}),
    ...(msg.forum_topic_created
      ? { service: { kind: 'created' as const, name: msg.forum_topic_created.name } }
      : msg.forum_topic_edited
        ? { service: { kind: 'renamed' as const, ...(msg.forum_topic_edited.name ? { name: msg.forum_topic_edited.name } : {}) } }
        : {}),
    shape: Object.keys(msg).filter(k => TRACED.includes(k)).join(',') || 'other',
  }
}

/** Updates from the group `chatId` only; anything from another chat is dropped here, with a log line. */
export function createTelegramInbound(bot: Bot, chatId: string, operatorId: string, log: (line: string) => void): ChatInbound {
  const polling = createPolling(bot)
  return {
    listen(handler: (event: ChatEvent) => Promise<void>) {
      bot.catch(err => {
        process.stderr.write(`telegram-topics-proxy: handler error (polling continues): ${err.error}\n`)
      })
      bot.on('message', async ctx => {
        if (String(ctx.chat.id) !== chatId) {
          log(`dropped a message from chat ${ctx.chat.id} (${ctx.chat.type}): only the group is relayed`)
          return
        }
        await handler({ type: 'message', message: telegramMessage(ctx.message, operatorId) })
      })
      // A button Telegram did not get from us is acknowledged and dropped. Answers
      // here are not logged when they fail: Telegram refuses a late answer routinely.
      bot.on('callback_query:data', async ctx => {
        const intent = decodeCallback(ctx.callbackQuery.data ?? '')
        if (!intent) {
          await ctx.answerCallbackQuery().catch(() => {})
          return
        }
        if (String(ctx.callbackQuery.message?.chat.id) !== chatId) {
          log(`refused a button press from chat ${ctx.callbackQuery.message?.chat.id ?? 'unknown'}: only the group is relayed`)
          await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
          return
        }
        const topic = topicOf(ctx.callbackQuery.message as { message_thread_id?: number } | undefined)
        const sender = telegramSender(ctx.callbackQuery.from, operatorId)
        await handler({ type: 'action', press: telegramActionPress(ctx, intent, topic, sender) })
      })
    },
    start: () => polling.run(),
    stop: () => polling.stop(),
    since: () => polling.since(),
  }
}
