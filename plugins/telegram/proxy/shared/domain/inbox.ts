// A topic's inbound items: queued, held by waiting readers, or handed out and
// awaiting acknowledgement.

export type Inbox<T> = {
  queue: T[]
  waiters: Array<(item: T | null) => void>
  inflight?: { id: string; item: T }
}

/** Ends the delivery the client names; any other id leaves the item in flight. */
export function acknowledge<T>(inbox: Inbox<T>, ack: string): void {
  if (inbox.inflight?.id === ack) inbox.inflight = undefined
}

/** Puts an unacknowledged item back at the head of the queue, for a reader that does not acknowledge. */
export function requeueInflight<T>(inbox: Inbox<T>): void {
  if (!inbox.inflight) return
  inbox.queue.unshift(inbox.inflight.item)
  inbox.inflight = undefined
}
