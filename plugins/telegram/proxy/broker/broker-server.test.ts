import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { connect } from 'net'
import { join } from 'path'
import { parseBrokerRequest, serveBroker } from './broker-server'
import { createRelaunchBroker } from './relaunch-broker'
import type { LedgerRecord } from './relaunch-broker'

const closers: Array<() => void> = []
afterEach(() => closers.splice(0).forEach(close => close()))

// The socket lives in a short tmp path: unix socket paths are capped near 104 bytes.
async function serve(rootAgentPid: number, relaunchMs = 0) {
  const path = join(mkdtempSync(join('/tmp', 'brk-')), 's')
  const ledger: LedgerRecord[] = []
  const relaunched: string[] = []
  const broker = createRelaunchBroker({
    root: 'general',
    rootAgentPid: () => rootAgentPid,
    facts: topic => (topic === '34' ? { parent: 'general', running: true, idle: true } : undefined),
    external: () => false,
    relaunch: async topic => {
      relaunched.push(topic)
      await Bun.sleep(relaunchMs)
    },
    callerTopic: () => undefined,
    record: entry => void ledger.push(entry),
    log: () => {},
  })
  const server = serveBroker(path, broker, () => {})
  closers.push(() => server.close())
  await Bun.sleep(50)
  return { path, ledger, relaunched }
}

const send = (path: string, line: string, later?: string) =>
  new Promise<string>((resolve, reject) => {
    let reply = ''
    const socket = connect(path, () => {
      socket.write(line)
      if (later) setTimeout(() => socket.write(later), 5)
    })
    socket.setEncoding('utf8')
    socket.on('data', c => (reply += c))
    socket.on('end', () => resolve(reply))
    socket.on('error', reject)
  })

test('the kernel names the caller: a process under the root agent may relaunch', async () => {
  const { path, ledger, relaunched } = await serve(process.pid)
  const reply = JSON.parse(await send(path, '{"op":"relaunch","topics":["34"]}\n'))
  expect(reply).toEqual({ caller: 'general', results: [{ topic: '34', outcome: 'applied' }] })
  expect([relaunched, ledger[0]?.caller_pid]).toEqual([['34'], process.pid])
})

test('one connection runs one request, whatever follows its first line', async () => {
  const { path, relaunched } = await serve(process.pid, 40)
  const line = '{"op":"relaunch","topics":["34"]}\n'
  await send(path, line, line)
  await Bun.sleep(30)
  expect(relaunched).toEqual(['34'])
})

test('a process outside the root agent\'s tree is refused, whatever it sends', async () => {
  const { path, ledger, relaunched } = await serve(999_999)
  const reply = JSON.parse(await send(path, '{"op":"relaunch","topics":["34"]}\n'))
  expect(reply.results[0].outcome).toBe('refused')
  expect([relaunched, ledger[0]?.kind]).toEqual([[], 'relaunch_refused'])
})

test('the CLI prints one outcome per topic and fails when any is refused', async () => {
  const { path } = await serve(process.pid)
  // Spawned without blocking: the server answering it runs in this process.
  const run = Bun.spawn(['bun', join(import.meta.dir, 'relaunch-cli.ts'), '34', '99'], {
    env: { ...process.env, TELEGRAM_TOPICS_BROKER_SOCKET: path },
    stdout: 'pipe',
  })
  expect([await new Response(run.stdout).text(), await run.exited]).toEqual(['34 applied\n99 refused (unknown topic)\n', 1])
})

test('only a well-formed relaunch request is read', () => {
  expect(parseBrokerRequest('{"op":"relaunch","topics":["34","general"]}')).toEqual({ op: 'relaunch', topics: ['34', 'general'] })
  expect(parseBrokerRequest('nope')).toBe('not JSON')
  expect(parseBrokerRequest('{"op":"kill","topics":["34"]}')).toBe('op must be "relaunch"')
  for (const topics of [[], ['a b'], [34], Array(101).fill('1')]) {
    expect(parseBrokerRequest(JSON.stringify({ op: 'relaunch', topics }))).toBe('topics must be 1 to 100 topic ids')
  }
})

test('a socket it cannot bind is logged, never thrown', async () => {
  const lines: string[] = []
  const broker = createRelaunchBroker({
    root: 'general', rootAgentPid: () => undefined, facts: () => undefined, external: () => false, relaunch: async () => {},
    callerTopic: () => undefined, record: () => {}, log: () => {},
  })
  const server = serveBroker('/nonexistent-dir/broker.sock', broker, line => void lines.push(line))
  closers.push(() => server.close())
  await Bun.sleep(50)
  expect(lines).toEqual([expect.stringMatching(/^broker: off, cannot listen on \/nonexistent-dir\/broker\.sock: /)])
})
