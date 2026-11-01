// What the phone is told, and when (docs/conductor.md, "Push"). Payloads carry
// as much of the text as fits Apple's 4 KB limit; the app's notification
// extension fetches the rest over the tailnet.
import type { BlobRef, StoredMessage } from './message'
import { plainText } from './plain-text'

export const PAYLOAD_LIMIT = 4096

export type Push = { payload: Record<string, unknown>; collapseId?: string }

/** Agent replies and proxy notices reach the phone; the operator's own words, ask posts and edits do not. */
export function pushable(message: StoredMessage): boolean {
  return message.author !== 'operator' && message.kind !== 'ask' && message.editedAt === null
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/** The longest prefix of `text` that keeps the payload within the limit. */
function fitBody(build: (body: string) => Record<string, unknown>, text: string): Record<string, unknown> {
  if (bytes(build(text)) <= PAYLOAD_LIMIT) return build(text)
  const chars = [...text]
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes(build(`${chars.slice(0, mid).join('')}…`)) <= PAYLOAD_LIMIT) low = mid
    else high = mid - 1
  }
  return build(`${chars.slice(0, low).join('')}…`)
}

/** What a message with no text shows: its attachments, named as Messages names them. */
export function attachmentLabel(blobs: readonly BlobRef[]): string {
  if (!blobs.length) return ''
  const noun = blobs.every(b => b.mime.startsWith('image/')) ? 'Photo' : 'Attachment'
  return blobs.length === 1 ? noun : `${blobs.length} ${noun}s`
}

/** The reply tool posts a text and its files as separate messages, this far apart at most. */
export const CAPTION_WINDOW_MS = 5_000

/** The text message a lone attachment belongs to: the same author's, just before it in the same topic. */
export function captionOf(media: StoredMessage, previous: StoredMessage | undefined): StoredMessage | undefined {
  if (!previous || media.text !== '' || !media.blobs.length) return undefined
  if (previous.topic !== media.topic || previous.author !== media.author || previous.text === '') return undefined
  const gap = Date.parse(media.at) - Date.parse(previous.at)
  return gap >= 0 && gap <= CAPTION_WINDOW_MS ? previous : undefined
}

/**
 * A message's push. With a `caption`, it replaces that message's notification
 * (same collapse id) silently, showing the caption, so a text and its files
 * read as one notification.
 */
export function messagePush(message: StoredMessage, topicName: string, badge: number, caption?: StoredMessage): Push {
  const reminder = message.kind === 'reminder'
  const words = caption ?? message
  // A notification cannot render markup, so it shows the message as plain text.
  const text = plainText(words.text, words.format) || attachmentLabel(message.blobs)
  const payload = fitBody(
    body => ({
      aps: {
        alert: { title: topicName, body },
        'thread-id': message.topic,
        badge,
        ...(reminder ? { category: 'REMINDER', 'interruption-level': 'time-sensitive' } : {}),
        'mutable-content': 1,
        ...(caption ? {} : { sound: 'default' }),
      },
      topic: message.topic,
      seq: message.seq,
      ...(message.blobs.length ? { blob: message.blobs[0].id } : {}),
    }),
    text,
  )
  return { payload, collapseId: caption?.id ?? message.id }
}

export type ApprovalForPush = { id: string; topic: string; prompt: string }

export function approvalPush(approval: ApprovalForPush, topicName: string): Push {
  const payload = fitBody(
    body => ({
      aps: {
        alert: { title: topicName, body },
        'thread-id': approval.topic,
        category: 'APPROVAL',
        'interruption-level': 'time-sensitive',
        'mutable-content': 1,
        sound: 'default',
      },
      topic: approval.topic,
      approval: approval.id,
    }),
    approval.prompt,
  )
  return { payload, collapseId: approval.id }
}
