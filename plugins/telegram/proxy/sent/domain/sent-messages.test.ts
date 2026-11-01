import { expect, test } from 'bun:test'
import { DELETE_WINDOW_MS, sentBy } from './sent-messages'

const NOW = Date.parse('2026-11-01T16:00:00Z')
const sent = [
  { topic: '42', id: 500, at: NOW - 1_000 },
  { topic: '43', id: 501, at: NOW - 1_000 },
  { topic: '42', id: 400, at: NOW - DELETE_WINDOW_MS },
]

test('a topic may delete only what it sent, inside the delete window', () => {
  expect(sentBy(sent, '42', 500, NOW)).toBeTrue()
  expect(sentBy(sent, '42', 501, NOW)).toBeFalse()
  expect(sentBy(sent, '42', 400, NOW)).toBeFalse()
  expect(sentBy(sent, '42', 999, NOW)).toBeFalse()
})
