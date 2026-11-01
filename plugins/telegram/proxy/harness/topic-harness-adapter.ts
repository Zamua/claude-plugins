import type { ChatPort } from '../chat/domain/chat-port'
import type { LockedHarness } from './domain/topic-harness'

/** Who sent a command or message, and where. */
export type TopicContext = { chatId: string; topic: string; fromId: string }

/** An inbound message for a harness-locked topic, described, with its channel meta. */
export type LockedTurn = { messageId?: number; text?: string; content: string; meta: Record<string, string> }

/**
 * A harness that owns a topic instead of a Claude pane, as Telegram drives it.
 * The proxy looks a topic's harness up once and hands it the command or message,
 * so adding a harness is one adapter and one registry entry.
 */
export interface TopicHarnessAdapter {
  readonly kind: LockedHarness
  /** The command that locks a fresh topic to this harness; its first group is the argument. */
  readonly lockCommand: RegExp
  /**
   * What the proxy fetches for its inbound files: nothing, or every attachment up front,
   * since only a Claude topic can fetch one itself through download_attachment.
   */
  readonly attachments: 'none' | 'eager'
  /** Logs every inbound message, for a harness whose turns are otherwise hard to trace. */
  readonly tracesInbound: boolean
  owns(topic: string): boolean
  lock(c: TopicContext, argument: string): Promise<void>
  model(c: TopicContext, argument: string): Promise<void>
  usage(c: TopicContext): Promise<void>
  relaunch(c: TopicContext): Promise<void>
  rename(topic: string, name: string): void
  receive(c: TopicContext, turn: LockedTurn): Promise<void>
  /** Called once the proxy has sent a reply into one of its topics. */
  sent(topic: string, messages: number): void
  /** Readies a new topic before Telegram creates it; the returned step locks it once it exists. */
  prepareTopic(name: string): Promise<(topic: string) => Promise<void>>
  /** Run every two seconds: applies a relaunch or route change queued until its topic went idle. */
  reconcile?(): Promise<unknown>
}

/** What every harness's Telegram front end needs from the proxy. */
export type HarnessPorts = {
  chat: ChatPort
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  /** Says why a topic cannot be locked to `harness` and returns false, else true. */
  mayLockTopic: (chatId: string, topic: string, fromId: string, harness: LockedHarness) => Promise<boolean>
}
