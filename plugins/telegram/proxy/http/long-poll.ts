// The proxy's long-polls: a queued item now, or the request held until one is
// handed to its waiter, answering 204 after the hold.
import { acknowledge } from '../shared/domain/inbox'
import type { Inbox } from '../shared/domain/inbox'
import { json } from './response'

export const LONG_POLL_MS = 25_000

/**
 * A waiter leaves the list the moment its client disconnects. A client that
 * died without the proxy noticing yet can still be handed an item, which is
 * then lost; acknowledged delivery (`acknowledgedPoll`) closes that gap.
 */
export function longPoll<T>(
  queue: T[],
  waiters: Array<(item: T | null) => void>,
  signal: AbortSignal,
  answer: (item: T) => unknown = item => item,
  holdMs = LONG_POLL_MS,
): Promise<Response> {
  const existing = queue.shift()
  if (existing) return Promise.resolve(json(answer(existing)))
  if (signal.aborted) return Promise.resolve(new Response(null, { status: 204 }))
  return new Promise<Response>(resolve => {
    const settle = (item: T | null) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', gone)
      const i = waiters.indexOf(wrapped)
      if (i >= 0) waiters.splice(i, 1)
      resolve(item ? json(answer(item)) : new Response(null, { status: 204 }))
    }
    const wrapped = (item: T | null) => settle(item)
    const gone = () => settle(null)
    const timer = setTimeout(gone, holdMs)
    signal.addEventListener('abort', gone, { once: true })
    waiters.push(wrapped)
  })
}

/**
 * A long-poll whose client confirms what it got: each item goes out with a
 * `delivery` id and stays in flight until the client's next poll names that id
 * in `ack`. A next poll that does not, whether from a client that never got
 * the item or one that started after it died, gets the same item again. An item
 * may so arrive twice, never not at all.
 */
export function acknowledgedPoll<T extends object>(
  inbox: Inbox<T>,
  ack: string,
  signal: AbortSignal,
  newId: () => string = () => crypto.randomUUID(),
  holdMs = LONG_POLL_MS,
): Promise<Response> {
  acknowledge(inbox, ack)
  if (inbox.inflight) return Promise.resolve(json({ ...inbox.inflight.item, delivery: inbox.inflight.id }))
  return longPoll(inbox.queue, inbox.waiters, signal, item => {
    inbox.inflight = { id: newId(), item }
    return { ...item, delivery: inbox.inflight.id }
  }, holdMs)
}
