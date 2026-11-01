import { expect, test } from 'bun:test'
import { acknowledgedPoll, longPoll } from './long-poll'
import type { Inbox } from '../shared/domain/inbox'

type Msg = { content: string }
const inbox = (): Inbox<Msg> => ({ queue: [], waiters: [] })
let n = 0
const ids = () => `d${++n}`
const body = async (res: Response) => (res.status === 204 ? null : res.json())

// The race: an item handed to a waiter whose client already died, before the
// proxy saw the disconnect. Here the dead client simply never reads its answer.
test('an item handed to a client that died is delivered again to the next poll, and only once it is acknowledged is it gone', async () => {
  const box = inbox()
  const dead = acknowledgedPoll(box, '', new AbortController().signal, ids, 1_000)
  box.waiters.shift()?.({ content: 'after the crash' })
  await dead // answered, but nobody received it
  const next = await body(await acknowledgedPoll(box, '', new AbortController().signal, ids, 50))
  expect(next).toEqual({ content: 'after the crash', delivery: expect.any(String) })
  const again = await body(await acknowledgedPoll(box, '', new AbortController().signal, ids, 50))
  expect(again?.delivery).toBe(next.delivery)
  expect(await acknowledgedPoll(box, next.delivery, new AbortController().signal, ids, 50).then(r => r.status)).toBe(204)
})

test('a client that acknowledges as it goes gets each item once, in order', async () => {
  const box = inbox()
  box.queue.push({ content: 'one' }, { content: 'two' })
  const first = await body(await acknowledgedPoll(box, '', new AbortController().signal, ids))
  const second = await body(await acknowledgedPoll(box, first.delivery, new AbortController().signal, ids))
  expect([first.content, second.content]).toEqual(['one', 'two'])
  expect(await acknowledgedPoll(box, second.delivery, new AbortController().signal, ids, 20).then(r => r.status)).toBe(204)
})

test('a stale or wrong ack does not drop the item in flight', async () => {
  const box = inbox()
  box.queue.push({ content: 'kept' })
  const first = await body(await acknowledgedPoll(box, '', new AbortController().signal, ids))
  expect((await body(await acknowledgedPoll(box, 'd-unknown', new AbortController().signal, ids)))?.delivery).toBe(first.delivery)
})

test('a plain long-poll answers at once, holds until an item comes, and gives up on its hold or its client', async () => {
  const queue: Msg[] = [{ content: 'ready' }]
  const waiters: Array<(m: Msg | null) => void> = []
  expect(await body(await longPoll(queue, waiters, new AbortController().signal))).toEqual({ content: 'ready' })
  const held = longPoll(queue, waiters, new AbortController().signal, m => m, 1_000)
  waiters[0]({ content: 'later' })
  expect(await body(await held)).toEqual({ content: 'later' })
  expect((await longPoll(queue, waiters, new AbortController().signal, m => m, 20)).status).toBe(204)
  const leaving = new AbortController()
  const gone = longPoll(queue, waiters, leaving.signal, m => m, 1_000)
  leaving.abort()
  expect((await gone).status).toBe(204)
  expect(waiters).toHaveLength(0)
})
