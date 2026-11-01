// The messages a topic's agent sent, kept for as long as Telegram lets a bot delete
// them, so an agent can delete what it posted and nothing else: never the operator's
// messages, never another topic's.

/** How long after sending Telegram lets a bot delete a message in a group. */
export const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000

export type SentMessage = { topic: string; id: number; at: number }

/** The messages still inside the delete window. */
export function deletableNow(messages: readonly SentMessage[], now: number): SentMessage[] {
  return messages.filter(m => now - m.at < DELETE_WINDOW_MS)
}

/** Whether `topic`'s agent sent message `id` and may still delete it. */
export function sentBy(messages: readonly SentMessage[], topic: string, id: number, now: number): boolean {
  return deletableNow(messages, now).some(m => m.topic === topic && m.id === id)
}
