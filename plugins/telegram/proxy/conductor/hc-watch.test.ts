import { afterEach, expect, test } from 'bun:test'
import type { Socket, UnixSocketListener } from 'bun'
import { rmSync } from 'fs'
import { hcRequest, watchHc } from './hc-watch'
import type { HcWatch } from './hc-watch'

// A stand-in core: answers a subscription with a snapshot, and a read with its text.
type Core = { listener: UnixSocketListener<undefined>; subscribers: Socket<undefined>[]; requests: string[] }
const cores: Core[] = []
const watches: HcWatch[] = []
afterEach(() => {
  watches.splice(0).forEach(w => w.stop())
  cores.splice(0).forEach(c => c.listener.stop(true))
})

const path = () => `/tmp/hcw-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`

const terminal = { address: 't4', state: 'live', labels: { session: 'claude-foo-7', topic: '7' }, reported: true, status: { app: 'claude-code', state: 'done' }, title: 'Fix it', cols: 200, foreground: { name: 'claude' } }

function core(socket: string, snapshot: unknown[] = [terminal]): Core {
  rmSync(socket, { force: true })
  const c: Core = { subscribers: [], requests: [], listener: undefined as never }
  c.listener = Bun.listen({
    unix: socket,
    socket: {
      data(s, chunk) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const req = JSON.parse(line)
          c.requests.push(req.method)
          if (req.method === 'events.subscribe') {
            c.subscribers.push(s)
            s.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { seq: 1, channel: null, terminals: snapshot } })}\n`)
          } else if (req.method === 'terminal.read') {
            s.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { text: `screen of ${req.params.terminal}`, complete: true, how: 'screen' } })}\n`)
          }
        }
      },
      close(s) {
        c.subscribers = c.subscribers.filter(x => x !== s)
      },
    },
  })
  cores.push(c)
  return c
}

function watch(socket: string, lines: string[] = [], changes = { n: 0 }) {
  const w = watchHc({ socket, log: l => void lines.push(l), retryMinMs: 20, silenceMs: 400 })
  w.onChange(() => void changes.n++)
  watches.push(w)
  return w
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(10)
  expect(check()).toBeTrue()
}

const send = (c: Core, frame: unknown) => c.subscribers.forEach(s => s.write(`${JSON.stringify(frame)}\n`))

test('the snapshot and later events tell which terminal hosts a session and what it reports', async () => {
  const socket = path()
  const c = core(socket)
  const w = watch(socket)
  await until(() => w.connected())
  expect(w.terminal('claude-foo-7')).toMatchObject({ address: 't4', status: 'done', title: 'Fix it', cols: 200 })
  send(c, { jsonrpc: '2.0', method: 'event', params: { type: 'status', seq: 2, terminal: 't4', data: { records: {}, reported: true, status: { state: 'working' } } } })
  await until(() => w.terminal('claude-foo-7')?.status === 'working')
  send(c, { jsonrpc: '2.0', method: 'event', params: { type: 'finished', seq: 3, terminal: 't4', data: { exit_code: 0, reason: 'exited' } } })
  await until(() => w.terminal('claude-foo-7') === undefined)
})

test('with no core listening it reports nothing, keeps trying, and connects once one starts', async () => {
  const socket = path()
  const lines: string[] = []
  const w = watch(socket, lines)
  await Bun.sleep(80)
  expect(w.connected()).toBeFalse()
  expect(w.terminal('claude-foo-7')).toBeUndefined()
  expect(lines.filter(l => l.includes('not connected'))).toHaveLength(1)
  core(socket)
  await until(() => w.connected(), 3000)
  expect(lines.at(-1)).toContain('hc events connected (1 terminals)')
})

test('a core that restarts or falls silent is subscribed to again, and a missed notice brings a fresh snapshot', async () => {
  const socket = path()
  let c = core(socket)
  const changes = { n: 0 }
  const w = watch(socket, [], changes)
  await until(() => w.connected())
  c.listener.stop(true)
  cores.splice(cores.indexOf(c), 1)
  await until(() => !w.connected())
  c = core(socket, [{ ...terminal, status: { state: 'blocked' } }])
  await until(() => w.terminal('claude-foo-7')?.status === 'blocked', 3000)
  const before = c.requests.filter(m => m === 'events.subscribe').length
  send(c, { jsonrpc: '2.0', method: 'missed', params: {} })
  await until(() => c.requests.filter(m => m === 'events.subscribe').length > before, 3000)
  expect(changes.n).toBeGreaterThan(2)
})

test('a silent connection is dropped and renewed', async () => {
  const socket = path()
  const c = core(socket)
  const w = watch(socket)
  await until(() => w.connected())
  await until(() => c.requests.filter(m => m === 'events.subscribe').length >= 2, 3000)
})

test('a screen read goes on its own connection; no core means no text', async () => {
  const socket = path()
  core(socket)
  const w = watch(socket)
  expect(await w.read('t4')).toBe('screen of t4')
  expect(await hcRequest(path(), 'terminal.read', { terminal: 't4' }, 200)).toBeUndefined()
})
