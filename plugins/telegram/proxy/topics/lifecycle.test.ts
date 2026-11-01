import { expect, test } from 'bun:test'
import { resumeNoticeTurn } from './lifecycle'

test('the resume notice is the proxy\'s own turn and carries no user id', () => {
  const turn = resumeNoticeTurn('43', 'answer the last unanswered message')
  expect(turn.meta.route_switch).toBe('1')
  expect(turn.meta.user_id ?? '').toBe('')
})
