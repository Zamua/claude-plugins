import { expect, test } from 'bun:test'
import { acknowledge, requeueInflight } from './inbox'
import type { Inbox } from './inbox'

const box = (): Inbox<string> => ({ queue: ['next'], waiters: [], inflight: { id: 'd1', item: 'sent' } })

test('only the in-flight delivery id acknowledges it', () => {
  const b = box()
  acknowledge(b, 'd0')
  acknowledge(b, '')
  expect(b.inflight?.id).toBe('d1')
  acknowledge(b, 'd1')
  expect(b.inflight).toBeUndefined()
})

test('an unacknowledged item goes back ahead of the queue', () => {
  const b = box()
  requeueInflight(b)
  expect(b).toEqual({ queue: ['sent', 'next'], waiters: [] })
})
