import { expect, test } from 'bun:test'
import { continuedIn, jobIdOf, MAX_HOPS, movesFrom, parkedNotice } from './parked-conversation'

const line = (entry: Record<string, unknown>) => JSON.stringify(entry)
const moved = (to: string) => line({ type: 'continued-in', sessionId: 'a', continuedInSessionId: to })

test('a move counts when nothing conversational follows it', () => {
  expect(continuedIn([line({ type: 'user' }), line({ type: 'assistant' }), moved('b'), line({ type: 'last-prompt' }), line({ type: 'cost-state' })])).toBe('b')
})

test('a conversation resumed under the old id after a move stays there', () => {
  expect(continuedIn([moved('b'), line({ type: 'last-prompt' }), line({ type: 'user' }), line({ type: 'assistant' })])).toBeUndefined()
})

test('no move, a cut first line, or a move with no target is no move', () => {
  expect(continuedIn([line({ type: 'user' }), line({ type: 'assistant' })])).toBeUndefined()
  expect(continuedIn(['ntinuedInSessionId":"b"}', line({ type: 'mode' })])).toBeUndefined()
  expect(continuedIn([line({ type: 'continued-in' })])).toBeUndefined()
  expect(continuedIn([])).toBeUndefined()
})

test('moves are followed to the session the conversation lives in now', () => {
  const next: Record<string, string> = { a: 'b', b: 'c' }
  expect(movesFrom('a', id => next[id], () => true)).toEqual(['b', 'c'])
  expect(movesFrom('c', id => next[id], () => true)).toEqual([])
})

test('a move to a session with no transcript, or back to one already seen, ends the chain', () => {
  expect(movesFrom('a', id => ({ a: 'b', b: 'c' })[id], id => id !== 'c')).toEqual(['b'])
  expect(movesFrom('a', id => ({ a: 'b', b: 'a' })[id], () => true)).toEqual(['b'])
})

test('a chain longer than the cap stops at the cap', () => {
  expect(movesFrom('s0', id => `s${Number(id.slice(1)) + 1}`, () => true)).toHaveLength(MAX_HOPS)
})

test('the notice names the job by the id claude stop takes', () => {
  const id = '7efd5994-b9db-4303-b37d-d361f2d3be79'
  expect(jobIdOf(id)).toBe('7efd5994')
  expect(parkedNotice(id)).toContain('`claude stop 7efd5994`')
})
