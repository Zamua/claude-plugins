import { describe, expect, test } from 'bun:test'
import { hcRuntime, parseHcTerminals } from './hc-terminals'
import type { HcTerminal } from './hc-terminals'

// Shaped as `terminal.list` answers over the hc API.
const listed = {
  terminals: [
    { address: 't1', name: 'tg-34', state: 'live', labels: { session: 'claude-hostthis-34', topic: '34' }, reported: true, status: { app: 'claude-code', state: 'done' }, foreground: { name: 'claude' }, title: ' Fix the build ', cols: 120 },
    { address: 't2', name: 'tg-35', state: 'finished', labels: { session: 'claude-x-35' }, reason: 'killed' },
    { address: 't3', name: 'probe', state: 'live', labels: {}, reported: false, foreground: { name: 'zsh' } },
    { address: 't4', name: 'tg-36', state: 'live', labels: { session: 'claude-y-36' }, reported: false, foreground: { name: 'claude' } },
  ],
}

describe('parseHcTerminals', () => {
  test('keeps each terminal\'s state, session label, reported status, foreground program, title and width', () => {
    expect(parseHcTerminals(listed)).toEqual([
      { state: 'live', address: 't1', session: 'claude-hostthis-34', status: 'done', foreground: 'claude', title: 'Fix the build', cols: 120 },
      { state: 'finished', address: 't2', session: 'claude-x-35' },
      { state: 'live', address: 't3', foreground: 'zsh' },
      { state: 'live', address: 't4', session: 'claude-y-36', foreground: 'claude' },
    ])
  })

  test('an answer it cannot read is no terminals, never a guess', () => {
    expect(parseHcTerminals(null)).toEqual([])
    expect(parseHcTerminals({ terminals: 'x' })).toEqual([])
  })
})

describe('hcRuntime', () => {
  const live = (over: Partial<Extract<HcTerminal, { state: 'live' }>> = {}): HcTerminal =>
    ({ state: 'live', address: 't1', session: 's', foreground: 'claude', ...over })

  test('Claude between turns reports done, which is as promptable as idle', () => {
    expect(hcRuntime(live({ status: 'idle' }))).toBe('idle')
    expect(hcRuntime(live({ status: 'done' }))).toBe('idle')
    expect(hcRuntime(live({ status: 'error' }))).toBe('idle')
  })

  test('a working agent is busy unless only background work runs behind a blank prompt', () => {
    expect(hcRuntime(live({ status: 'working' }))).toBe('busy')
    expect(hcRuntime(live({ status: 'working' }), true)).toBe('idle')
  })

  test('a dialog blocks it', () => {
    expect(hcRuntime(live({ status: 'blocked' }))).toBe('blocked')
  })

  test('before its first report an agent is starting, but a bare shell is a dead agent', () => {
    expect(hcRuntime(live())).toBe('starting')
    expect(hcRuntime(live({ foreground: 'zsh' }))).toBe('missing')
    expect(hcRuntime(live({ foreground: undefined }))).toBe('missing')
  })

  test('a finished terminal, or none, is missing', () => {
    expect(hcRuntime({ state: 'finished', address: 't2', session: 's' })).toBe('missing')
    expect(hcRuntime(undefined)).toBe('missing')
  })
})
