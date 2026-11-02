// The chat transport the proxy talks through, with no vendor in it: topics are
// keys the proxy already uses ("general" or a thread id), messages are opaque ids
// only the adapter makes, and each transport states what it can do so callers
// adapt to it instead of assuming Telegram.
import type { Actions } from './actions'

declare const messageIdBrand: unique symbol
/**
 * A message's id in the chat. Opaque: only the adapter makes one, from what its
 * transport returned or from a value a caller holds (`ChatPort.messageId`).
 */
export type MessageId = number & { readonly [messageIdBrand]: true }

/**
 * `markdown` means this transport's own dialect, named in its capabilities;
 * `gfm` is GitHub-flavored Markdown, which each transport renders as best it can.
 */
export type TextFormat = 'plain' | 'markdown' | 'gfm'

export type MarkdownDialect = 'telegram-markdownv2' | 'commonmark' | 'none'

export type ChatCapabilities = {
  buttons: boolean
  edits: boolean
  threads: boolean
  reactions: boolean
  /** Can ask the reader to answer a message in place. */
  forceReply: boolean
  /** Longer text is sent as several messages. */
  maxMessageLength: number
  markdown: MarkdownDialect
  /** Reports reactions and edits to earlier messages. */
  inboundReactionsAndEdits: boolean
  /** Hosts agent sessions and reports their state (working, blocked, idle, done). */
  sessionStates: boolean
}

export type OutgoingText = {
  text: string
  format?: TextFormat
  /** The message this answers; when the text is split, only the first part carries it. */
  replyTo?: MessageId
  /** Opens the reader's reply box on this message, with a hint in it. */
  forceReply?: { placeholder: string }
  /** Buttons under the message; on a split text, under its last part. */
  actions?: Actions
  /** Delivered without a notification, for an echo of what the reader just did. */
  silent?: boolean
}

export type OutgoingFile = {
  file: { path: string } | { bytes: Uint8Array; name: string }
  kind: 'photo' | 'document'
  caption?: string
  replyTo?: MessageId
}

export type ChatCommand = { command: string; description: string }

export interface ChatPort {
  readonly capabilities: ChatCapabilities
  /** Sends text into a topic, split at the transport's limit, and gives every part's id. */
  send(topic: string, message: OutgoingText): Promise<MessageId[]>
  sendFile(topic: string, file: OutgoingFile): Promise<MessageId>
  /** Replaces a message's text and gives the id it now has. */
  edit(id: MessageId, text: string, format?: TextFormat): Promise<MessageId>
  delete(id: MessageId): Promise<void>
  react(id: MessageId, emoji: string): Promise<void>
  /** Shows that something is being written or uploaded in a topic, briefly. */
  typing(topic: string, activity: 'text' | 'upload'): Promise<void>
  /** Saves an inbound attachment locally and gives its path, or null when it cannot. */
  download(fileRef: string, nameHint?: string): Promise<string | null>
  /** Creates a topic and gives its key. */
  createTopic(name: string): Promise<string>
  /** Renames a topic, General included. */
  renameTopic(topic: string, name: string): Promise<void>
  /** The command menu the chat offers its members. */
  setCommands(commands: readonly ChatCommand[]): Promise<void>
  /** A link that opens the message for a reader, when the transport has one. */
  link(topic: string, id: MessageId): string | null
  /** The message id a caller holds (a request field, a stored value), when it names one here. */
  messageId(raw: unknown): MessageId | undefined
}
