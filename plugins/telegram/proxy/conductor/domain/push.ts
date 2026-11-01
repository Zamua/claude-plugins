// What the phone is told, and when (docs/conductor.md, "Push"). Payloads carry
// as much of the text as fits Apple's 4 KB limit; the app's notification
// extension fetches the rest over the tailnet.
import type { StoredMessage } from './message'

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

export function messagePush(message: StoredMessage, topicName: string, badge: number): Push {
  const reminder = message.kind === 'reminder'
  const text = message.text || (message.blobs.length ? `[${message.blobs.length === 1 ? 'image' : `${message.blobs.length} images`}]` : '')
  const payload = fitBody(
    body => ({
      aps: {
        alert: { title: topicName, body },
        'thread-id': message.topic,
        badge,
        ...(reminder ? { category: 'REMINDER', 'interruption-level': 'time-sensitive' } : {}),
        'mutable-content': 1,
        sound: 'default',
      },
      topic: message.topic,
      seq: message.seq,
    }),
    text,
  )
  return { payload }
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
