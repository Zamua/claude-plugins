import { expect, test } from 'bun:test'
import type { HcTerminal } from '../../shared/hc-terminals'
import { agentState } from './agent-state'

const terminal = (over: Partial<Extract<HcTerminal, { state: 'live' }>> = {}): HcTerminal =>
  ({ state: 'live', address: 't1', session: 's', foreground: 'claude', ...over })
const on = (t: HcTerminal | undefined, core = true) => ({ core, terminal: t })

test('the lifecycle decides first: a failed start is missing, a stopped agent is stopped', () => {
  expect(agentState('failed', on(terminal({ status: 'working' })))).toBe('missing')
  expect(agentState('stopped', on(terminal({ status: 'working' })))).toBe('stopped')
})

test('a running topic off hc is idle: nothing finer is known', () => {
  expect(agentState('running')).toBe('idle')
})

test('a running hc topic shows what its terminal reports', () => {
  expect(agentState('running', on(terminal({ status: 'done' })))).toBe('idle')
  expect(agentState('running', on(terminal({ status: 'working' })))).toBe('working')
  expect(agentState('running', on(terminal({ status: 'blocked' })))).toBe('blocked')
  expect(agentState('running', on(terminal()))).toBe('starting')
  expect(agentState('running', on(terminal({ foreground: 'zsh' })))).toBe('missing')
  expect(agentState('running', on(undefined))).toBe('missing')
})

test('with no hc core answering, a running hc topic is missing', () => {
  expect(agentState('running', on(terminal({ status: 'done' }), false))).toBe('missing')
})
