import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'crypto'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ApnsEnv, ApnsReply, ApnsSender } from './apns'
import type { Push } from './domain/push'
import { startConfiguredPush, startPush } from './push-service'
import { ConductorStore } from './sqlite-store'

const open: ConductorStore[] = []
afterEach(() => open.splice(0).forEach(s => s.close()))

type Sent = { env: ApnsEnv; token: string; push: Push }

function setup(reply: (token: string) => ApnsReply | Error = () => ({ status: 200 })) {
  const store = new ConductorStore(mkdtempSync(join(tmpdir(), 'push-')))
  open.push(store)
  const sent: Sent[] = []
  const lines: string[] = []
  const sender: ApnsSender = {
    send: async (env, token, push) => {
      sent.push({ env, token, push })
      const r = reply(token)
      if (r instanceof Error) throw r
      return r
    },
    close: () => {},
  }
  const service = startPush({
    store, sender, log: line => void lines.push(line),
    topics: () => [{ id: 'general', name: 'General' }, { id: '7', name: 'build' }],
  })
  const phone = store.enroll({ name: 'phone', publicKey: 'BK1', nodeId: 'n1', apnsToken: 'aa', apnsEnv: 'production' }).device
  return { store, sent, lines, service, phone }
}

const agent = (topic: string, text: string) => ({ topic, text, author: 'agent' as const, origin: 'proxy' as const, format: 'plain' as const })
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

test('an agent message is pushed to each device with a token, titled by its topic, badged with total unread', async () => {
  const { store, sent, lines } = setup()
  store.enroll({ name: 'pad', publicKey: 'BK2', nodeId: 'n1', apnsToken: 'bb', apnsEnv: 'sandbox' })
  store.enroll({ name: 'mac', publicKey: 'BK3', nodeId: 'n1', apnsToken: null, apnsEnv: null })
  store.append(agent('general', 'earlier'))
  await settle()
  sent.length = 0
  store.append(agent('7', 'tests pass'))
  await settle()
  expect(sent.map(s => [s.env, s.token])).toEqual([['production', 'aa'], ['sandbox', 'bb']])
  expect(sent[0].push.payload).toMatchObject({ aps: { alert: { title: 'build', body: 'tests pass' }, badge: 2, 'thread-id': '7' }, topic: '7', seq: 1 })
  expect(lines.some(l => /^push: 7#1 -> dev_\w+ 200 \d+ms, \d+ms after stored$/.test(l))).toBeTrue()
})

test('the operator\'s messages, ask posts and unlisted topics are not pushed', async () => {
  const { store, sent } = setup()
  store.append({ ...agent('7', 'mine'), author: 'operator', origin: 'app' })
  store.append({ ...agent('7', 'You asked: why'), author: 'proxy', kind: 'ask' })
  store.append(agent('square', 'peer chatter'))
  await settle()
  expect(sent).toEqual([])
})

test('a message is pushed once, however many events name it', async () => {
  const { store, sent } = setup()
  const m = store.append(agent('7', 'once'))
  store.setDelivery(m.id, 'delivered')
  await settle()
  expect(sent).toHaveLength(1)
})

test('a token Apple calls dead is dropped; any other refusal or a network error keeps it', async () => {
  for (const [reply, kept] of [
    [{ status: 410, reason: 'Unregistered' }, false],
    [{ status: 400, reason: 'BadDeviceToken' }, false],
    [{ status: 429, reason: 'TooManyRequests' }, true],
    [new Error('socket hang up'), true],
  ] as const) {
    const { store, phone, lines } = setup(() => reply)
    store.append(agent('7', 'hi'))
    await settle()
    expect(store.device(phone.id)?.apnsToken ?? null).toBe(kept ? 'aa' : null)
    if (reply instanceof Error) expect(lines.some(l => l.includes('failed after') && l.includes('socket hang up'))).toBeTrue()
  }
})

test('nothing is pushed once stopped', async () => {
  const { store, sent, service } = setup()
  service.stop()
  store.append(agent('7', 'late'))
  await settle()
  expect(sent).toEqual([])
})

test('push is on only with every setting and a usable key, and says why not', () => {
  const store = new ConductorStore(mkdtempSync(join(tmpdir(), 'push-')))
  open.push(store)
  const lines: string[] = []
  const ports = { store, topics: () => [], log: (line: string) => void lines.push(line) }
  const keyFile = join(mkdtempSync(join(tmpdir(), 'push-key-')), 'apns.p8')
  writeFileSync(keyFile, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const settings = { keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'app.example' }
  expect(startConfiguredPush({ ...settings, teamId: '' }, ports)).toBeUndefined()
  expect(startConfiguredPush({ ...settings, keyFile: `${keyFile}.missing` }, ports)).toBeUndefined()
  const on = startConfiguredPush(settings, ports)
  expect(on).toBeDefined()
  on?.stop()
  expect(lines[0]).toBe('push: off, missing teamId')
  expect(lines[1]).toStartWith('push: off, the key cannot be used')
  expect(lines[2]).toBe('push: on for app.example')
})
