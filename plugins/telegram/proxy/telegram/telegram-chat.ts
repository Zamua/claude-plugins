// The chat port over the Bot API, for the one forum group the proxy serves.
// Telegram's own rules live here: MarkdownV2, the 4096-character split, forum
// threads, and the group-scoped command menu.
import { GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { Api, Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import type { ActionIntent, ActionPress, Actions } from '../chat/domain/actions'
import type { Sender } from '../chat/domain/inbound'
import type { ChatCapabilities, ChatPort, MessageId, OutgoingFile, OutgoingText, TextFormat } from '../chat/domain/chat-port'
import { decodeCallback, encodeCallback } from './telegram-callback'
import type { Downloader } from './telegram-files'
import { chunk, MAX_CHUNK_LIMIT, messageLink, threadOf } from './telegram-messages'
import { markdownV2, markdownV2Blocks, messageParts } from './markdown-v2'

export const TELEGRAM_CAPABILITIES: ChatCapabilities = {
  buttons: true,
  edits: true,
  threads: true,
  reactions: true,
  forceReply: true,
  maxMessageLength: MAX_CHUNK_LIMIT,
  markdown: 'telegram-markdownv2',
  // The proxy does not subscribe to message_reaction or edited_message updates
  inboundReactionsAndEdits: false,
  sessionStates: false,
}

type TelegramApi = Pick<
  Api,
  | 'sendMessage'
  | 'sendPhoto'
  | 'sendDocument'
  | 'editMessageText'
  | 'deleteMessage'
  | 'setMessageReaction'
  | 'sendChatAction'
  | 'createForumTopic'
  | 'editForumTopic'
  | 'editGeneralForumTopic'
  | 'setMyCommands'
>

const telegramId = (id: number) => id as MessageId

/** Buttons as an inline keyboard, each carrying its intent as callback data. */
export function renderActions(actions: Actions): InlineKeyboard {
  return new InlineKeyboard(actions.map(row => row.map(a => InlineKeyboard.text(a.label, encodeCallback(a.intent)))))
}

/** A pressed inline button as the port hands it on, answered through the callback query it came in. */
export function telegramActionPress(ctx: Context, intent: ActionIntent, topic: string, sender: Sender): ActionPress {
  const rows: unknown = (ctx.callbackQuery?.message as { reply_markup?: { inline_keyboard?: unknown } } | undefined)
    ?.reply_markup?.inline_keyboard
  const siblings = (Array.isArray(rows) ? rows.flat() : [])
    .map(button => decodeCallback(String((button as { callback_data?: unknown })?.callback_data ?? '')))
    .filter((i): i is ActionIntent => i !== undefined)
  return {
    intent,
    topic,
    sender,
    text: (ctx.callbackQuery?.message as { text?: string } | undefined)?.text ?? '',
    siblings,
    answer: async feedback => {
      await ctx.answerCallbackQuery(feedback ? { text: feedback.text, ...(feedback.alert ? { show_alert: true } : {}) } : undefined)
    },
    update: async (text, actions) => {
      await ctx.editMessageText(text, actions ? { reply_markup: renderActions(actions) } : undefined)
    },
    clearActions: async () => {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    },
  }
}
const parseMode = (format?: TextFormat) => (format === 'markdown' ? { parse_mode: 'MarkdownV2' as const } : {})

/** Telegram refused the markup itself; the same text plain will go. */
const unparsed = (error: unknown) => error instanceof GrammyError && error.error_code === 400 && /can't parse entities/i.test(error.description)
const replyTo = (id?: MessageId) => (id != null ? { reply_parameters: { message_id: id } } : {})

export function createTelegramChat(api: TelegramApi, chatId: string, download: Downloader): ChatPort {
  /** GitHub Markdown, converted per message part; a part Telegram cannot parse goes as its Markdown source, plain. */
  async function sendMarkdown(topic: string, message: OutgoingText): Promise<MessageId[]> {
    let parts: Array<{ v2?: string; source: string }>
    try {
      parts = messageParts(markdownV2Blocks(message.text), MAX_CHUNK_LIMIT)
    } catch {
      return send(topic, { ...message, format: 'plain' })
    }
    const ids: MessageId[] = []
    for (let i = 0; i < parts.length; i++) {
      const options = {
        ...threadOf(topic),
        ...(i === 0 ? replyTo(message.replyTo) : {}),
        ...(message.silent ? { disable_notification: true } : {}),
        ...(message.actions && i === parts.length - 1 ? { reply_markup: renderActions(message.actions) } : {}),
      }
      const { v2, source } = parts[i]
      let sent
      try {
        sent = v2 === undefined ? await api.sendMessage(chatId, source, options) : await api.sendMessage(chatId, v2, { ...options, parse_mode: 'MarkdownV2' })
      } catch (error) {
        if (v2 === undefined || !unparsed(error)) throw error
        sent = await api.sendMessage(chatId, source, options)
      }
      ids.push(telegramId(sent.message_id))
    }
    return ids
  }

  async function send(topic: string, message: OutgoingText): Promise<MessageId[]> {
    if (message.format === 'gfm' && !message.forceReply) return sendMarkdown(topic, message)
    const ids: MessageId[] = []
    const parts = chunk(message.text, MAX_CHUNK_LIMIT)
    for (let i = 0; i < parts.length; i++) {
      const sent = await api.sendMessage(chatId, parts[i], {
        ...threadOf(topic),
        ...(i === 0 ? replyTo(message.replyTo) : {}),
        ...parseMode(message.format),
        ...(message.silent ? { disable_notification: true } : {}),
        ...(message.forceReply
          ? { reply_markup: { force_reply: true, input_field_placeholder: message.forceReply.placeholder } }
          : message.actions && i === parts.length - 1
            ? { reply_markup: renderActions(message.actions) }
            : {}),
      })
      ids.push(telegramId(sent.message_id))
    }
    return ids
  }

  async function sendFile(topic: string, out: OutgoingFile): Promise<MessageId> {
    const input = 'path' in out.file ? new InputFile(out.file.path) : new InputFile(out.file.bytes, out.file.name)
    const options = { ...threadOf(topic), ...replyTo(out.replyTo), ...(out.caption != null ? { caption: out.caption } : {}) }
    const sent = out.kind === 'photo'
      ? await api.sendPhoto(chatId, input, options)
      : await api.sendDocument(chatId, input, options)
    return telegramId(sent.message_id)
  }

  async function edit(id: MessageId, text: string, format?: TextFormat): Promise<MessageId> {
    if (format === 'gfm') {
      let v2: string | undefined
      try {
        v2 = markdownV2(text)
      } catch {}
      if (v2 !== undefined) {
        try {
          const edited = await api.editMessageText(chatId, id, v2, { parse_mode: 'MarkdownV2' })
          return typeof edited === 'object' ? telegramId(edited.message_id) : id
        } catch (error) {
          if (!unparsed(error)) throw error
        }
      }
      return edit(id, text, 'plain')
    }
    const mode = parseMode(format)
    const edited = await api.editMessageText(chatId, id, text, ...('parse_mode' in mode ? [mode] : []))
    return typeof edited === 'object' ? telegramId(edited.message_id) : id
  }

  return {
    capabilities: TELEGRAM_CAPABILITIES,
    send,
    sendFile,
    edit,
    delete: async id => {
      await api.deleteMessage(chatId, id)
    },
    react: async (id, emoji) => {
      await api.setMessageReaction(chatId, id, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }])
    },
    typing: async (topic, activity) => {
      await api.sendChatAction(chatId, activity === 'text' ? 'typing' : 'upload_photo', threadOf(topic))
    },
    download: (fileRef, nameHint) => download(fileRef, nameHint),
    createTopic: async name => String((await api.createForumTopic(chatId, name)).message_thread_id),
    renameTopic: async (topic, name) => {
      if (topic === 'general') await api.editGeneralForumTopic(chatId, name)
      else await api.editForumTopic(chatId, Number(topic), { name })
    },
    setCommands: async commands => {
      await api.setMyCommands(commands, { scope: { type: 'chat', chat_id: Number(chatId) } })
    },
    link: (topic, id) => messageLink(chatId, topic, id),
    messageId: raw => {
      const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
      return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? telegramId(n) : undefined
    },
  }
}
