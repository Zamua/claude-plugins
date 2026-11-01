import type { Approval } from './approval'

// A message as the conductor keeps it: what was said in a topic, by whom, from
// where, in the order the topic saw it. The shapes follow docs/conductor.md.

export type Author = 'operator' | 'agent' | 'proxy'
export type Origin = 'app' | 'telegram' | 'proxy'
/** As written by its author; the app renders it. */
export type MessageFormat = 'plain' | 'markdown' | 'markdownv2'
/** A proxy message that is a reminder firing or an ask's post; null for any other message. */
export type MessageKind = 'reminder' | 'ask' | null
export type Reaction = { emoji: string }
/** An operator message sent from the app: stored, then handed to the topic's agent or not. */
export type Delivery = 'accepted' | 'delivered' | 'failed'

export type BlobRef = { id: string; mime: string; bytes: number; width: number | null; height: number | null }

export type NewMessage = {
  topic: string
  author: Author
  origin: Origin
  kind?: MessageKind
  text: string
  format: MessageFormat
  blobs?: readonly BlobRef[]
  /** The id, in this store, of the message it answers. */
  replyTo?: string
  /** The message's ids in the chat it was relayed through, for cross reference. */
  chatIds?: readonly number[]
  at?: string
  /** The app's idempotency key, on a message sent from the app. */
  clientId?: string
  delivery?: Delivery
}

export type StoredMessage = Required<Omit<NewMessage, 'replyTo' | 'chatIds' | 'clientId' | 'delivery'>> & {
  id: string
  seq: number
  replyTo: string | null
  chatIds: readonly number[]
  editedAt: string | null
  reactions: readonly Reaction[]
  clientId: string | null
  delivery: Delivery | null
  failure: string | null
  /** History brought in from before the store began; its seq is at or below zero. */
  imported: boolean
}

/** A message of earlier history as the importer stores it, whole. */
export type ImportedMessage = Pick<StoredMessage, 'id' | 'topic' | 'seq' | 'author' | 'kind' | 'text' | 'format' | 'replyTo' | 'chatIds' | 'at' | 'editedAt' | 'blobs'>

/** A stored message, or news about a topic (its state, title, name or route), which a client reads as the topic now. */
export type StoredEvent =
  | { cursor: number; type: 'message'; message: StoredMessage }
  | { cursor: number; type: 'topic'; topic: string }
  | { cursor: number; type: 'approval'; approval: Approval }

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', pdf: 'application/pdf', txt: 'text/plain', json: 'application/json',
}

export function mimeFor(name: string): string {
  const extension = name.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}
