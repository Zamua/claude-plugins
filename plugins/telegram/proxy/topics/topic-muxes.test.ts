import { describe, expect, test } from 'bun:test'
import type { MultiplexerPort } from './multiplexer'
import { topicMuxes } from './topic-muxes'

function fake(kind: MultiplexerPort['kind'], live: string[]): MultiplexerPort & { killed: string[] } {
  const sessions = new Set(live)
  const killed: string[] = []
  return {
    kind, killed,
    liveSessions: () => new Set(sessions),
    runtime: s => (sessions.has(s) ? 'idle' : 'missing'),
    prompt: () => true,
    interrupt: s => sessions.has(s),
    kill: s => (killed.push(s), sessions.delete(s)),
  }
}

describe('topicMuxes', () => {
  test('a topic configured onto hc runs there; every other topic keeps the default backend', () => {
    const herdr = fake('herdr', [])
    const hc = fake('hc', [])
    const muxes = topicMuxes(herdr, hc, new Set(['61']))
    expect(muxes.forTopic('61').kind).toBe('hc')
    expect(muxes.forTopic('62').kind).toBe('herdr')
    expect(muxes.forTopic('general').kind).toBe('herdr')
  })

  test('without hc every topic stays on the default, whatever the list says', () => {
    const tmux = fake('tmux', [])
    expect(topicMuxes(tmux, undefined, new Set(['61'])).forTopic('61').kind).toBe('tmux')
  })

  test('live sessions are every backend\'s, so a session is found wherever it runs', () => {
    const muxes = topicMuxes(fake('herdr', ['claude-a-1']), fake('hc', ['claude-b-61']), new Set(['61']))
    expect([...muxes.liveSessions()].sort()).toEqual(['claude-a-1', 'claude-b-61'])
  })

  test('a moved topic\'s session still running in its old backend is found there, and only there', () => {
    const herdr = fake('herdr', ['claude-b-61'])
    const hc = fake('hc', [])
    const muxes = topicMuxes(herdr, hc, new Set(['61']))
    expect(muxes.elsewhere('61', 'claude-b-61').map(m => m.kind)).toEqual(['herdr'])
    expect(muxes.elsewhere('62', 'claude-c-62')).toEqual([])
  })
})
