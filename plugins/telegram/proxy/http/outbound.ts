// The MCP's outbound tools (reply, react, edit_message, download_attachment),
// executed against the one bot. Each can only target the configured group.
import { statSync } from 'fs'
import { extname } from 'path'
import { InputFile } from 'grammy'
import type { Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { ENV_FILES, GROUP_CHAT_ID, STATE_DIR } from '../config'
import type { Downloader } from '../telegram/telegram-files'
import {
  assertSendable,
  chunk,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_LIMIT,
  PHOTO_EXTS,
  threadIdForTopic,
} from '../telegram/telegram-messages'
import { parseDownload, parseEdit, parseReact, parseSend } from './requests'
import { json } from './response'

export type OutboundPorts = {
  api: Api
  downloadFile: Downloader
  /** Told once a reply has gone out in a topic. */
  sent: (topic: string, messages: number) => void
}

function assertGroup(chatId: unknown): void {
  if (String(chatId) !== String(GROUP_CHAT_ID)) {
    throw new Error(`chat ${chatId} is not the configured group`)
  }
}

export function createOutbound({ api, downloadFile, sent }: OutboundPorts) {
  async function handleSend(req: Request): Promise<Response> {
    const { chatId, topic, text, replyTo, files, markdown } = parseSend(await req.json())
    assertGroup(chatId)
    const threadId = threadIdForTopic(topic)
    const parseMode = markdown ? ('MarkdownV2' as const) : undefined

    for (const f of files) {
      assertSendable(f, STATE_DIR, ENV_FILES)
      const st = statSync(f)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
      }
    }

    const ids: number[] = []
    const chunks = text.length ? chunk(text, MAX_CHUNK_LIMIT) : []
    for (let i = 0; i < chunks.length; i++) {
      const message = await api.sendMessage(chatId, chunks[i], {
        ...(threadId != null ? { message_thread_id: threadId } : {}),
        ...(replyTo != null && i === 0 ? { reply_parameters: { message_id: replyTo } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      ids.push(message.message_id)
    }

    for (const f of files) {
      const ext = extname(f).toLowerCase()
      const opts = {
        ...(threadId != null ? { message_thread_id: threadId } : {}),
        ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
      }
      const input = new InputFile(f)
      const message = PHOTO_EXTS.has(ext)
        ? await api.sendPhoto(chatId, input, opts)
        : await api.sendDocument(chatId, input, opts)
      ids.push(message.message_id)
    }

    sent(topic, ids.length)
    return json({ message_ids: ids })
  }

  async function handleReact(req: Request): Promise<Response> {
    const b = parseReact(await req.json())
    assertGroup(b.chatId)
    await api.setMessageReaction(b.chatId, b.messageId, [
      { type: 'emoji', emoji: b.emoji as ReactionTypeEmoji['emoji'] },
    ])
    return json({ ok: true })
  }

  async function handleEdit(req: Request): Promise<Response> {
    const b = parseEdit(await req.json())
    assertGroup(b.chatId)
    const parseMode = b.markdown ? ('MarkdownV2' as const) : undefined
    const edited = await api.editMessageText(
      b.chatId,
      b.messageId,
      b.text,
      ...(parseMode ? [{ parse_mode: parseMode }] : []),
    )
    const id = typeof edited === 'object' ? edited.message_id : b.messageId
    return json({ message_id: id })
  }

  async function handleDownload(req: Request): Promise<Response> {
    const path = await downloadFile(parseDownload(await req.json()).fileId)
    if (!path) throw new Error('download failed (file may have expired)')
    return json({ path })
  }

  return { handleSend, handleReact, handleEdit, handleDownload }
}
