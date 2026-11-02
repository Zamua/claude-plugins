// The MCP's outbound tools (reply, react, edit_message, delete_message,
// download_attachment), executed through the chat port. Each can only target the
// configured group.
import { statSync } from 'fs'
import { extname } from 'path'
import type { ChatPort, MessageId } from '../chat/domain/chat-port'
import { ENV_FILES, GROUP_CHAT_ID, STATE_DIR } from '../config'
import { assertSendable, MAX_ATTACHMENT_BYTES, PHOTO_EXTS } from '../telegram/telegram-messages'
import { BadRequest, parseDelete, parseDownload, parseEdit, parseReact, parseSend } from './requests'
import { json } from './response'

/** A reply that has gone out in a topic. */
export type SentReply = { topic: string; ids: MessageId[]; text: string; replyTo?: number }

export type OutboundPorts = {
  chat: ChatPort
  sent: (reply: SentReply) => void
  /** The messages each topic's agent sent; an agent may delete only its own. */
  sentMessages: { sentBy(topic: string, id: number): boolean; forget(topic: string, id: number): void }
}

function assertGroup(chatId: unknown): void {
  if (String(chatId) !== String(GROUP_CHAT_ID)) {
    throw new Error(`chat ${chatId} is not the configured group`)
  }
}

export function createOutbound({ chat, sent, sentMessages }: OutboundPorts) {
  const messageId = (raw: number): MessageId => {
    const id = chat.messageId(raw)
    if (!id) throw new BadRequest('message_id must name a message')
    return id
  }

  async function handleSend(req: Request): Promise<Response> {
    const { chatId, topic, text, replyTo, files, format } = parseSend(await req.json())
    assertGroup(chatId)

    for (const f of files) {
      assertSendable(f, STATE_DIR, ENV_FILES)
      const st = statSync(f)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
      }
    }

    const answering = replyTo != null ? { replyTo: messageId(replyTo) } : {}
    const ids = text.length
      ? await chat.send(topic, { text, ...(format !== 'plain' ? { format } : {}), ...answering })
      : []
    for (const f of files) {
      const kind = PHOTO_EXTS.has(extname(f).toLowerCase()) ? 'photo' : 'document'
      ids.push(await chat.sendFile(topic, { file: { path: f }, kind, ...answering }))
    }

    sent({ topic, ids, text, ...(replyTo != null ? { replyTo } : {}) })
    return json({ message_ids: ids })
  }

  async function handleReact(req: Request): Promise<Response> {
    const b = parseReact(await req.json())
    assertGroup(b.chatId)
    await chat.react(messageId(b.messageId), b.emoji)
    return json({ ok: true })
  }

  async function handleEdit(req: Request): Promise<Response> {
    const b = parseEdit(await req.json())
    assertGroup(b.chatId)
    const id = await chat.edit(messageId(b.messageId), b.text, b.format)
    return json({ message_id: id })
  }

  // Only a message this topic's agent sent, inside Telegram's delete window: the bot
  // is a group admin, so Telegram alone would let it delete the operator's messages.
  async function handleDelete(req: Request): Promise<Response> {
    const { chatId, topic, messageId: raw } = parseDelete(await req.json())
    assertGroup(chatId)
    if (!sentMessages.sentBy(topic, raw)) {
      return json({ error: `message ${raw} was not sent from this topic in the last 48 hours` }, 403)
    }
    await chat.delete(messageId(raw))
    sentMessages.forget(topic, raw)
    return json({ deleted: raw })
  }

  async function handleDownload(req: Request): Promise<Response> {
    const path = await chat.download(parseDownload(await req.json()).fileId)
    if (!path) throw new Error('download failed (file may have expired)')
    return json({ path })
  }

  return { handleSend, handleReact, handleEdit, handleDelete, handleDownload }
}
