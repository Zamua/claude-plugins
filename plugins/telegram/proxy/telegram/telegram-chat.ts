// The chat port over the Bot API, for the one forum group the proxy serves.
// Telegram's own rules live here: MarkdownV2, the 4096-character split, forum
// threads, and the group-scoped command menu.
import { InputFile } from 'grammy'
import type { Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import type { ChatCapabilities, ChatPort, MessageId, OutgoingFile, OutgoingText, TextFormat } from '../chat/domain/chat-port'
import type { Downloader } from './telegram-files'
import { chunk, MAX_CHUNK_LIMIT, messageLink, threadOf } from './telegram-messages'

export const TELEGRAM_CAPABILITIES: ChatCapabilities = {
  buttons: true,
  edits: true,
  threads: true,
  reactions: true,
  forceReply: true,
  maxMessageLength: MAX_CHUNK_LIMIT,
  markdown: 'telegram-markdownv2',
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
  | 'setMyCommands'
>

const telegramId = (id: number) => id as MessageId
const parseMode = (format?: TextFormat) => (format === 'markdown' ? { parse_mode: 'MarkdownV2' as const } : {})
const replyTo = (id?: MessageId) => (id != null ? { reply_parameters: { message_id: id } } : {})

export function createTelegramChat(api: TelegramApi, chatId: string, download: Downloader): ChatPort {
  async function send(topic: string, message: OutgoingText): Promise<MessageId[]> {
    const ids: MessageId[] = []
    const parts = chunk(message.text, MAX_CHUNK_LIMIT)
    for (let i = 0; i < parts.length; i++) {
      const sent = await api.sendMessage(chatId, parts[i], {
        ...threadOf(topic),
        ...(i === 0 ? replyTo(message.replyTo) : {}),
        ...parseMode(message.format),
        ...(message.forceReply
          ? { reply_markup: { force_reply: true, input_field_placeholder: message.forceReply.placeholder } }
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
