import { describe, expect, test } from 'bun:test'
import { HcMux, hcEnvironment } from './hc-mux'
import type { HcCall } from './hc-mux'

type Terminal = { address: string; state: 'live' | 'finished'; labels: Record<string, string>; reported?: boolean; status?: { state: string }; foreground?: { name: string } }

// The hc API as the adapter sees it: terminal.list, read, send, kill and rm over one call.
function fakeCore(terminals: Terminal[], screen = '') {
  const calls: Array<[string, Record<string, unknown>]> = []
  const call: HcCall = (method, params) => {
    calls.push([method, params])
    const t = terminals.find(x => x.address === params.terminal)
    switch (method) {
      case 'terminal.list': return { terminals: terminals.filter(x => x.state === 'live') }
      case 'terminal.read': return t ? { text: screen } : null
      case 'terminal.send': return t ? { started: true } : null
      case 'terminal.kill': if (!t) return null; t.state = 'finished'; return t
      case 'terminal.rm': if (!t || t.state === 'live') return null; terminals.splice(terminals.indexOf(t), 1); return { removed: t.address }
      default: return null
    }
  }
  return { mux: new HcMux(call), calls, terminals }
}

const claude = (address: string, session: string, state?: string): Terminal => ({
  address, state: 'live', labels: { session }, foreground: { name: 'claude' },
  ...(state ? { reported: true, status: { state } } : { reported: false }),
})

describe('HcMux', () => {
  test('a session is live while its agent runs or starts, never once only a shell is left', () => {
    const { mux } = fakeCore([
      claude('t1', 'claude-a-1', 'done'),
      claude('t2', 'claude-b-2'),
      { address: 't3', state: 'live', labels: { session: 'claude-c-3' }, reported: false, foreground: { name: 'zsh' } },
      { address: 't4', state: 'live', labels: {}, reported: true, status: { state: 'idle' }, foreground: { name: 'claude' } },
    ])
    expect([...mux.liveSessions()].sort()).toEqual(['claude-a-1', 'claude-b-2'])
  })

  test('runtime reads the agent\'s own status; a working one with a blank prompt runs only background work', () => {
    const blank = '\n❯ \n  Claude · opus\n'
    const { mux } = fakeCore([claude('t1', 'claude-a-1', 'working'), claude('t2', 'claude-b-2', 'blocked')], blank)
    expect(mux.runtime('claude-a-1')).toBe('idle')
    expect(mux.runtime('claude-b-2')).toBe('blocked')
    expect(mux.runtime('claude-none-9')).toBe('missing')
    expect(fakeCore([claude('t1', 'claude-a-1', 'working')], 'thinking...').mux.runtime('claude-a-1')).toBe('busy')
  })

  test('a prompt goes in only at a turn boundary, and Claude\'s done counts as one', () => {
    const { mux, calls } = fakeCore([claude('t1', 'claude-a-1', 'done'), claude('t2', 'claude-b-2', 'working')])
    expect(mux.prompt('claude-a-1', 'hello\nthere')).toBeTrue()
    expect(mux.prompt('claude-b-2', 'not now')).toBeFalse()
    expect(calls.filter(([m]) => m === 'terminal.send')).toEqual([['terminal.send', { terminal: 't1', text: 'hello\nthere' }]])
  })

  test('kill ends the agent and removes its terminal, so a finished one does not linger', () => {
    const { mux, terminals } = fakeCore([claude('t1', 'claude-a-1', 'done')])
    expect(mux.kill('claude-a-1')).toBeTrue()
    expect(terminals).toEqual([])
    expect(mux.kill('claude-a-1')).toBeFalse()
  })

  test('an hc that does not answer reads as no sessions, not a crash', () => {
    const mux = new HcMux(() => null)
    expect(mux.liveSessions().size).toBe(0)
    expect(mux.runtime('claude-a-1')).toBe('missing')
    expect(mux.prompt('claude-a-1', 'x')).toBeFalse()
  })
})

test('hc gets only what picks its session, never the proxy\'s own variables', () => {
  expect(hcEnvironment({ HOME: '/h', PATH: '/bin', HC_SESSION: 'lab', TELEGRAM_BOT_TOKEN: 'secret', TG_KICKOFF: 'k' }))
    .toEqual({ HOME: '/h', PATH: '/bin', HC_SESSION: 'lab' })
})
