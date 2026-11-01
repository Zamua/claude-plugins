// What a button in the chat means, and the buttons a message carries. A transport
// with buttons renders them natively; one without may render them as text and map
// the reader's answer back to the same intent.
import type { AntigravityEffort } from '../../harness/antigravity/domain/antigravity-topic'
import type { Effort, PickerReason, ProviderId } from '../../routing/domain/model-routing'

/**
 * What a button means. Buttons already posted in a chat outlive any deploy, so
 * an adapter's encoding of these must keep decoding what it encoded before.
 */
export type ActionIntent =
  | { kind: 'permission'; behavior: 'allow' | 'deny'; requestId: string }
  | { kind: 'providers'; reason: PickerReason; topic: string }
  | { kind: 'provider'; provider: ProviderId; reason: PickerReason; topic: string }
  | { kind: 'models'; provider: ProviderId; reason: PickerReason; topic: string; page: number }
  | { kind: 'model'; token: string }
  | { kind: 'effort'; token: string; effort: Effort }
  | { kind: 'ultracode'; token: string; on: boolean }
  | { kind: 'usage'; topic: string }
  | { kind: 'switch-back'; provider: ProviderId; topic: string }
  | { kind: 'dismiss' }
  | { kind: 'antigravity-models'; topic: string; page: number }
  | { kind: 'antigravity-model'; token: string }
  | { kind: 'antigravity-effort'; token: string; effort: AntigravityEffort }
  | { kind: 'antigravity-usage'; topic: string }

export type Action = { label: string; intent: ActionIntent }

/** Rows of buttons, top to bottom. */
export type Actions = Action[][]

/** A pressed button: what it meant, where, and how to answer the reader who pressed it. */
export interface ActionPress {
  readonly intent: ActionIntent
  readonly topic: string
  /** The verified identity of whoever pressed it. */
  readonly senderId: string
  /** The intents of every button on the pressed message, the pressed one included. */
  readonly siblings: readonly ActionIntent[]
  /** Acknowledges the press, with a short note or an alert the reader must dismiss. */
  answer(feedback?: { text: string; alert?: boolean }): Promise<void>
  /** Replaces the pressed message's text, and its buttons when given. */
  update(text: string, actions?: Actions): Promise<void>
  clearActions(): Promise<void>
}
