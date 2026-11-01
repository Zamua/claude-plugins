// What the chat hands the proxy: messages and pressed buttons, each from a sender
// the transport itself verified. Events arrive one at a time; the next waits until
// the handler for the previous one has settled, which the proxy relies on (a
// topic's first two messages must not both spawn its agent).
import type { ActionPress } from './actions'
import type { MessageId } from './chat-port'

/**
 * Who sent a message or pressed a button, as the transport verified it. `role` is
 * `operator` only for the account the proxy is configured to obey; the adapter
 * decides it from the transport's own authenticated sender, never from content.
 */
export type Sender = { id: string; name: string; role: 'operator' | 'member' }

export type Attachment = { kind: string; ref: string; size?: number; mime?: string; name?: string }

export type ChatMessage = {
  topic: string
  id: MessageId
  /** The chat's own id, as a turn's meta names it. */
  chatId: string
  sender: Sender
  /** When it was sent, epoch ms. */
  at: number
  text?: string
  caption?: string
  /** The message as a turn's content; absent for one with nothing to relay. */
  content?: string
  photo?: { ref: string; uniqueRef: string }
  attachment?: Attachment
  /** The message this one answers, with its text. */
  replyTo?: { id: MessageId; text: string }
  /** A topic created or renamed, and its new name (absent when only its icon changed). */
  service?: { kind: 'created' | 'renamed'; name?: string }
  /** What the message carried, for the inbound trace. */
  shape: string
}

/** An agent session's state, for a transport that shows sessions. */
export type SessionState = 'working' | 'blocked' | 'idle' | 'done'

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'action'; press: ActionPress }
  | { type: 'reaction'; topic: string; id: MessageId; sender: Sender; emoji: string }
  | { type: 'edit'; message: ChatMessage }
  | { type: 'session'; topic: string; state: SessionState }

export interface ChatInbound {
  /** Hands every event to `handler`, one at a time. */
  listen(handler: (event: ChatEvent) => Promise<void>): void
  /** Receives until stopped, retrying a transport that drops. */
  start(): Promise<void>
  stop(): Promise<void>
  /** When receiving last started, or null while it is down. */
  since(): number | null
}
