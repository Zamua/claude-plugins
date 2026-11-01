// Telegram messages as the proxy relays them: inbound ones described as channel
// content, outbound text chunked to Telegram's limit, outbound files guarded.
import { realpathSync } from 'fs'
import { join, sep } from 'path'
import { describeLocation, describeVenue } from './location'

export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

// reply's files param takes any path, and the proxy would InputFile+send it.
// A prompt-injected topic-Claude could call reply(files:['.../telegram-topics/.env'])
// to ship the bot token to the group. Refuse the proxy's own state (everything
// under the state dir except the inbox subdir) and the token-bearing .env files.
// Claude can already Read+paste arbitrary file contents, so this is not a new
// exfil channel for other paths - it just closes the one path Claude has no
// reason to ever send: the server's own credentials/state.
export function assertSendable(f: string, stateDir: string, envFiles: readonly string[]): void {
  const real = realOrNull(f)
  if (real === null) return // statSync will fail with a proper error later
  const stateReal = realOrNull(stateDir)
  if (stateReal) {
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }
  for (const envf of envFiles) {
    const er = realOrNull(envf)
    if (er && real === er) {
      throw new Error(`refusing to send credential file: ${f}`)
    }
  }
}

// Telegram caps messages at 4096 chars. Split long replies on the char count.
export function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    out.push(rest.slice(0, limit))
    rest = rest.slice(limit)
  }
  if (rest) out.push(rest)
  return out
}

// Uploader-controlled names land inside the <channel> meta; strip delimiters so
// they cannot break out of the tag or forge a second meta entry.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

export type Described = {
  content: string
  attachment?: AttachmentMeta
  photo?: { file_id: string; file_unique_id: string }
}

// Turn a Telegram message into the channel content string plus any attachment /
// photo descriptors. Returns null for messages we do not relay (service
// messages with no user content).
export function describeMessage(msg: any): Described | null {
  if (typeof msg.text === 'string') return { content: msg.text }
  if (msg.photo) {
    const best = msg.photo[msg.photo.length - 1]
    return {
      content: msg.caption ?? '(photo)',
      photo: { file_id: best.file_id, file_unique_id: best.file_unique_id },
    }
  }
  if (msg.document) {
    const d = msg.document
    const name = safeName(d.file_name)
    return {
      content: msg.caption ?? `(document: ${name ?? 'file'})`,
      attachment: { kind: 'document', file_id: d.file_id, size: d.file_size, mime: d.mime_type, name },
    }
  }
  if (msg.voice) {
    const v = msg.voice
    return {
      content: msg.caption ?? '(voice message)',
      attachment: { kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type },
    }
  }
  if (msg.audio) {
    const a = msg.audio
    const name = safeName(a.file_name)
    return {
      content: msg.caption ?? `(audio: ${safeName(a.title) ?? name ?? 'audio'})`,
      attachment: { kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name },
    }
  }
  if (msg.video) {
    const v = msg.video
    return {
      content: msg.caption ?? '(video)',
      attachment: {
        kind: 'video',
        file_id: v.file_id,
        size: v.file_size,
        mime: v.mime_type,
        name: safeName(v.file_name),
      },
    }
  }
  if (msg.video_note) {
    const v = msg.video_note
    return { content: '(video note)', attachment: { kind: 'video_note', file_id: v.file_id, size: v.file_size } }
  }
  if (msg.sticker) {
    const s = msg.sticker
    const emoji = s.emoji ? ` ${s.emoji}` : ''
    return { content: `(sticker${emoji})`, attachment: { kind: 'sticker', file_id: s.file_id, size: s.file_size } }
  }
  // A venue also carries a location, so it is checked first.
  if (msg.venue) return { content: describeVenue(msg.venue) }
  if (msg.location) return { content: describeLocation(msg.location) }
  return null
}

/** The forum thread a topic key names; the General topic has none. */
export function threadIdForTopic(topic: string): number | undefined {
  return topic === 'general' ? undefined : Number(topic)
}

/** Send options that put a message in a topic's thread. */
export const threadOf = (topic: string) => (topic === 'general' ? {} : { message_thread_id: Number(topic) })
