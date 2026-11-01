// Records what passes through the chat into the conductor's store without
// changing how anything is sent or delivered: a recording that fails is
// reported, never thrown.
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { ChatPort, MarkdownDialect, TextFormat } from '../chat/domain/chat-port'
import type { InboundMsg } from '../topics/state'
import { mimeFor } from './domain/message'
import type { BlobRef, MessageFormat, MessageKind, NewMessage, StoredMessage } from './domain/message'

export type MessageLog = {
  append(message: NewMessage): StoredMessage
  addBlob(bytes: Uint8Array, mime: string): BlobRef
}

/** The format a message was written in, named as the app renders it. */
export function formatOf(format: TextFormat | undefined, dialect: MarkdownDialect): MessageFormat {
  if (format !== 'markdown') return 'plain'
  if (dialect === 'telegram-markdownv2') return 'markdownv2'
  return dialect === 'commonmark' ? 'markdown' : 'plain'
}

/** The chat as before, with every text and file it sends stored as `as` says. */
export function mirroredChat(
  chat: ChatPort,
  log: MessageLog,
  as: { author: 'agent' | 'proxy'; kind?: MessageKind },
  report: (error: unknown) => void,
): ChatPort {
  const record = (message: Pick<NewMessage, 'topic' | 'text' | 'format' | 'blobs' | 'chatIds'>) => {
    try {
      log.append({ ...message, author: as.author, origin: 'proxy', kind: as.kind ?? null })
    } catch (error) {
      report(error)
    }
  }
  return {
    capabilities: chat.capabilities,
    async send(topic, message) {
      const ids = await chat.send(topic, message)
      record({ topic, text: message.text, format: formatOf(message.format, chat.capabilities.markdown), chatIds: ids })
      return ids
    },
    async sendFile(topic, file) {
      const id = await chat.sendFile(topic, file)
      try {
        const bytes = 'path' in file.file ? readFileSync(file.file.path) : file.file.bytes
        const name = 'path' in file.file ? basename(file.file.path) : file.file.name
        record({ topic, text: file.caption ?? '', format: 'plain', blobs: [log.addBlob(bytes, mimeFor(name))], chatIds: [id] })
      } catch (error) {
        report(error)
      }
      return id
    },
    edit: (id, text, format) => chat.edit(id, text, format),
    delete: id => chat.delete(id),
    react: (id, emoji) => chat.react(id, emoji),
    typing: (topic, activity) => chat.typing(topic, activity),
    download: (ref, nameHint) => chat.download(ref, nameHint),
    createTopic: name => chat.createTopic(name),
    setCommands: commands => chat.setCommands(commands),
    link: (topic, id) => chat.link(topic, id),
    messageId: raw => chat.messageId(raw),
  }
}

/**
 * The turn queue as before, with each operator turn stored first. Only a turn
 * carrying the operator's id is one: proxy-made turns carry none, and a secret
 * drop never becomes a turn.
 */
export function recordingOperatorTurns(
  enqueue: (topic: string, msg: InboundMsg) => void,
  log: MessageLog,
  operatorId: string,
  report: (error: unknown) => void,
): (topic: string, msg: InboundMsg) => void {
  return (topic, msg) => {
    if (operatorId !== '' && msg.meta.user_id === operatorId) {
      try {
        const image = msg.meta.image_path
        const chatId = Number(msg.meta.message_id)
        log.append({
          topic,
          author: 'operator',
          origin: 'telegram',
          text: msg.content,
          format: 'plain',
          blobs: image ? [log.addBlob(readFileSync(image), mimeFor(image))] : [],
          chatIds: Number.isFinite(chatId) ? [chatId] : [],
          ...(msg.meta.ts ? { at: msg.meta.ts } : {}),
        })
      } catch (error) {
        report(error)
      }
    }
    enqueue(topic, msg)
  }
}
