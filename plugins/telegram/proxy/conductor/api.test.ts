import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'crypto'
import { createConductorApi } from './api'
import { conductorControl } from './control'
import { scheduleReminder } from '../reminders/domain/reminder'
import type { Reminder } from '../reminders/domain/reminder'
import { SecretExists, SecretMissing } from '../secrets/secret'
import type { DeliverAppMessage, TopicSummary } from './api'
import type { ScreenView } from './wire'
import type { Peer } from './domain/identity'
import { Ledger, brokenLine } from './ledger'
import { ConductorStore } from './sqlite-store'

const signing = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'docs', 'conductor-v1', 'signing.json'), 'utf8'))
const topicFixture = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'docs', 'conductor-v1', 'topic.json'), 'utf8'))

const PHONE: Peer = { nodeId: 'nPHONE', login: 'operator@example.com' }

let dir: string
let store: ConductorStore
let server: ReturnType<typeof Bun.serve>
let base: string
let peer: Peer
let notices: string[]
let deliveries: Array<Parameters<DeliverAppMessage>[0]>
let deliverOutcome: Awaited<ReturnType<DeliverAppMessage>>
let api: ReturnType<typeof createConductorApi>
let listed: TopicSummary[]
let screenOf: (topic: string) => ScreenView | undefined
let topicsChanged: () => void
let controlled: string[]
let logged: string[]
let kept: Map<string, string>
let reminderList: Reminder[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-api-'))
  store = new ConductorStore(dir)
  peer = PHONE
  notices = []
  deliveries = []
  deliverOutcome = { delivered: true }
  listed = [
    { id: 'general', name: 'General', kind: 'claude', title: null, route: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'xhigh' }, state: 'idle', parentId: null, spawnedBy: null, spawnedAt: null },
    { id: '42', name: 'build', kind: 'claude', title: null, route: null, state: 'stopped', parentId: 'general', spawnedBy: 'operator', spawnedAt: '2026-10-30T14:02:11.000Z' },
  ]
  screenOf = () => undefined
  topicsChanged = () => {}
  controlled = []
  logged = []
  kept = new Map()
  reminderList = []
  api = createConductorApi({
    store,
    ledger: new Ledger(join(dir, 'ledger.jsonl')),
    policy: { selfNodeId: 'nSELF', operatorLogin: 'operator@example.com', allowedNodes: new Set(['nPHONE', 'nIPAD']) },
    whois: async () => peer,
    topics: () => listed,
    screen: async topic => screenOf(topic),
    watchTopics: changed => void (topicsChanged = changed),
    control: conductorControl({
      catalog: () => ({ anthropic: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high', 'xhigh'], defaultEffort: 'xhigh' }], codex: [], 'opencode-go': [] }),
      capacities: () => [],
      refreshCapacity: async () => {},
      usageText: () => 'Provider usage',
      ultracode: () => false,
      requestRoute: (topic, choice) => {
        controlled.push(`route ${topic} ${choice.model.id} ${choice.effort}`)
        return { outcome: 'applied', route: { provider: choice.provider, model: choice.model.id, effort: choice.effort, ultracode: false } }
      },
      routeChangeText: () => 'Now using it.',
      noAgent: () => undefined,
      locked: () => undefined,
      relaunch: async topic => void controlled.push(`relaunch ${topic}`),
      interrupt: () => false,
      say: async () => {},
      createTopic: async name => {
        listed = [...listed, { id: '501', name, kind: 'claude', title: null, route: null, state: 'stopped', parentId: 'general', spawnedBy: 'operator', spawnedAt: null }]
        return '501'
      },
      renameTopic: async (topic, name) => void (listed = listed.map(t => (t.id === topic ? { ...t, name } : t))),
      setPrefs: (topic, prefs) => store.setPrefs(topic, prefs),
      listed: topic => listed.some(t => t.id === topic),
      secretsOn: () => true,
      listSecrets: () => [...kept.entries()].map(([name, value]) => ({ name, bytes: value.length, mtime: new Date('2026-11-01T20:25:37.123Z') })),
      storeSecret: async (name, value, replace) => {
        if (kept.has(name) && !replace) throw new SecretExists(kept.get(name)!.length)
        const replaced = kept.has(name)
        kept.set(name, value)
        return { path: `/home/op/keys/${name}`, bytes: value.length, replaced }
      },
      deleteSecret: async name => {
        if (!kept.has(name)) throw new SecretMissing()
        const bytes = kept.get(name)!.length
        kept.delete(name)
        return { bytes }
      },
      topicReminders: topic => reminderList.filter(r => r.topic === topic),
      addReminder: request => {
        const r = scheduleReminder(request, Date.parse('2026-11-01T20:25:37.123Z'), `rm_${reminderList.length + 1}`)
        reminderList.push(r)
        return r
      },
      cancelReminder: id => {
        const found = reminderList.find(r => r.id === id)
        reminderList = reminderList.filter(r => r.id !== id)
        return found
      },
    }),
    notify: text => notices.push(text),
    deliver: async input => {
      deliveries.push(input)
      return deliverOutcome
    },
    log: line => void logged.push(line),
    version: '1.0.0-test',
  })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: api.fetch, websocket: api.websocket })
  base = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  api.stop()
  server.stop(true)
  store.close()
})

const enroll = (body: Record<string, unknown> = { public_key: signing.public_key, name: 'iPhone', apns_env: 'sandbox' }) =>
  fetch(`${base}/v1/devices`, { method: 'POST', body: JSON.stringify(body) })
const enrolled = async () => ((await (await enroll()).json()) as { id: string }).id
const get = (path: string, device?: string) => fetch(`${base}${path}`, { headers: device ? { 'X-Device': device } : {} })

describe('who may call', () => {
  test('this machine is refused even with an enrolled device; so is another user', async () => {
    const device = await enrolled()
    peer = { nodeId: 'nSELF', login: 'operator@example.com' }
    expect((await get('/v1/me', device)).status).toBe(403)
    peer = { nodeId: 'nPHONE', login: 'guest@example.com' }
    expect(await (await get('/v1/me', device)).json()).toEqual({ error: { code: 'not_operator', message: 'this peer may not use the conductor' } })
  })

  test('a read needs a device enrolled from the node calling', async () => {
    const device = await enrolled()
    expect((await get('/v1/me')).status).toBe(401)
    expect((await get('/v1/me', 'dev_unknown')).status).toBe(401)
    peer = { nodeId: 'nIPAD', login: 'operator@example.com' }
    expect((await get('/v1/me', device)).status).toBe(401)
  })
})

describe('enrollment', () => {
  test('a new device is stored, written to the ledger, and announced; enrolling again changes nothing', async () => {
    const first = await enroll()
    expect(first.status).toBe(201)
    const device = await first.json()
    expect(device).toMatchObject({ name: 'iPhone', public_key: signing.public_key, apns_env: 'sandbox' })
    expect(notices).toHaveLength(1)
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
    expect(JSON.parse(ledger.trim())).toMatchObject({ kind: 'enroll', device: device.id, node: 'nPHONE' })
    expect(brokenLine(ledger)).toBeUndefined()
    const again = await enroll()
    expect([again.status, (await again.json()).id]).toEqual([200, device.id])
    expect(notices).toHaveLength(1)
  })

  test('a bad key or name is refused, and a key enrolled from another node cannot be taken over', async () => {
    expect((await enroll({ public_key: 'AAAA', name: 'x' })).status).toBe(400)
    expect((await enroll({ public_key: signing.public_key, name: '' })).status).toBe(400)
    await enroll()
    peer = { nodeId: 'nIPAD', login: 'operator@example.com' }
    expect((await enroll()).status).toBe(409)
  })
})

describe('reads', () => {
  test('/v1/me names the device and the contract', async () => {
    const device = await enrolled()
    expect(await (await get('/v1/me', device)).json()).toMatchObject({ device: { id: device }, contract: 'v1' })
  })

  test('topics come with the cursor they are current to, general pinned first, in the contract\'s shape', async () => {
    const device = await enrolled()
    store.append({ topic: '42', author: 'agent', origin: 'proxy', text: 'built', format: 'plain' })
    const body = await (await get('/v1/topics', device)).json()
    expect(body.cursor).toBe(1)
    expect(body.history_since).toBe(store.historySince())
    expect(typeof body.history_since).toBe('string')
    expect(body.topics[1].last_message.format).toBe('plain')
    expect(body.topics.map((t: { id: string }) => t.id)).toEqual(['general', '42'])
    expect(Object.keys(body.topics[1]).sort()).toEqual(Object.keys(topicFixture).sort())
    expect(body.topics[1]).toMatchObject({ unread: 1, last_message: { preview: 'built', author: 'agent' }, pinned: false })
  })

  test('history pages newest first with the cursor, and blobs are served with their type', async () => {
    const device = await enrolled()
    const blob = store.addBlob(new Uint8Array([1, 2, 3]), 'image/png')
    for (const text of ['a', 'b', 'c']) store.append({ topic: '42', author: 'agent', origin: 'proxy', text, format: 'plain', blobs: text === 'c' ? [blob] : [] })
    const page = await (await get('/v1/topics/42/messages?limit=2', device)).json()
    expect([page.cursor, page.messages.map((m: { text: string }) => m.text)]).toEqual([3, ['c', 'b']])
    const older = await (await get('/v1/topics/42/messages?before_seq=2', device)).json()
    expect(older.messages.map((m: { text: string }) => m.text)).toEqual(['a'])
    expect((await get('/v1/topics/42/messages?limit=500', device)).status).toBe(400)
    const bytes = await get(`/v1/blobs/${blob.id}`, device)
    expect([bytes.headers.get('content-type'), [...new Uint8Array(await bytes.arrayBuffer())]]).toEqual(['image/png', [1, 2, 3]])
  })
})

describe('the stream', () => {
  const open = async (device: string) => {
    const frames: Array<Record<string, unknown>> = []
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/stream`, { headers: { 'X-Device': device } } as never)
    ws.onmessage = e => frames.push(JSON.parse(String(e.data)))
    await new Promise(resolve => (ws.onopen = resolve))
    return { ws, frames }
  }
  const settle = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))

  test('hello with since replays what was missed, then ready, then live events', async () => {
    const device = await enrolled()
    store.append({ topic: '42', author: 'agent', origin: 'proxy', text: 'one', format: 'plain' })
    store.append({ topic: '42', author: 'agent', origin: 'proxy', text: 'two', format: 'plain' })
    const { ws, frames } = await open(device)
    ws.send(JSON.stringify({ type: 'hello', since: 1 }))
    await settle()
    store.append({ topic: 'general', author: 'proxy', origin: 'proxy', text: 'three', format: 'plain' })
    await settle()
    ws.close()
    expect(frames.map(f => f.type === 'message' ? `${f.cursor}:${(f.message as { text: string }).text}` : `${f.type}:${f.cursor}`))
      .toEqual(['2:two', 'ready:2', '3:three'])
  })

  test('hello without since replays nothing; a cursor from the future means reset', async () => {
    const device = await enrolled()
    store.append({ topic: '42', author: 'agent', origin: 'proxy', text: 'old', format: 'plain' })
    const live = await open(device)
    live.ws.send(JSON.stringify({ type: 'hello' }))
    const ahead = await open(device)
    ahead.ws.send(JSON.stringify({ type: 'hello', since: 99 }))
    await settle()
    live.ws.close()
    ahead.ws.close()
    expect(live.frames).toEqual([{ type: 'ready', cursor: 1 }])
    expect(ahead.frames).toEqual([{ type: 'reset' }])
  })

  test('a topic whose state or title changes is a topic event carrying the topic now, live and replayed', async () => {
    const device = await enrolled()
    const { ws, frames } = await open(device)
    ws.send(JSON.stringify({ type: 'hello' }))
    await settle()
    listed = [listed[0], { ...listed[1], state: 'working', title: 'Fix the flaky test' }]
    topicsChanged()
    await settle()
    const event = frames.find(f => f.type === 'topic') as { cursor: number; topic: Record<string, unknown> }
    expect(event.cursor).toBe(1)
    expect(event.topic).toMatchObject({ id: '42', state: 'working', title: 'Fix the flaky test' })
    expect(typeof event.topic.state_since).toBe('string')
    expect(Object.keys(event.topic).sort()).toEqual(Object.keys(topicFixture).sort())
    const again = await open(device)
    again.ws.send(JSON.stringify({ type: 'hello', since: 0 }))
    await settle()
    ws.close()
    again.ws.close()
    expect(again.frames.map(f => f.type)).toEqual(['topic', 'ready'])
  })

  test('a screen goes to the connections watching it, once per change and on every state change', async () => {
    const device = await enrolled()
    let rows = ['❯ bun test']
    screenOf = topic => (topic === '42' ? { topic, rows, cols: 120, working: true } : undefined)
    const watcher = await open(device)
    const other = await open(device)
    for (const c of [watcher, other]) c.ws.send(JSON.stringify({ type: 'hello' }))
    watcher.ws.send(JSON.stringify({ type: 'subscribe', screen: '42' }))
    await settle(700)
    rows = ['❯ bun test', ' 485 pass']
    await settle(700)
    listed = [listed[0], { ...listed[1], state: 'idle' }]
    topicsChanged()
    await settle(200)
    watcher.ws.send(JSON.stringify({ type: 'unsubscribe', screen: '42' }))
    rows = ['done']
    await settle(700)
    const screens = watcher.frames.filter(f => f.type === 'screen').map(f => f.screen as Record<string, unknown> & { rows: string[] })
    expect(screens.map(s => s.rows.length)).toEqual([1, 2, 2])
    expect(screens[0]).toEqual({ topic: '42', rows: ['❯ bun test'], cols: 120, cursor: null, working: true })
    expect(other.frames.some(f => f.type === 'screen')).toBeFalse()
    watcher.ws.close()
    other.ws.close()
  })

  test('a topic with no screen, or none listed, gets an error naming it', async () => {
    const device = await enrolled()
    const { ws, frames } = await open(device)
    ws.send(JSON.stringify({ type: 'hello' }))
    ws.send(JSON.stringify({ type: 'subscribe', screen: 'general' }))
    ws.send(JSON.stringify({ type: 'subscribe', screen: 'nope' }))
    await settle()
    ws.close()
    expect(frames.filter(f => f.type === 'error').map(f => [f.screen, (f.error as { code: string }).code]))
      .toEqual([['general', 'no_screen'], ['nope', 'no_screen']])
  })

  test('the stream needs a device like any read', async () => {
    expect((await get('/v1/stream', 'dev_nope')).status).toBe(401)
  })
})

// The DER prefix that makes a 65-byte P-256 point a SubjectPublicKeyInfo.
const SPKI_P256 = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')

// A device key the tests hold, like the app's Secure Enclave key.
function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64')
  const headers = (method: string, path: string, clientId: string, body: Uint8Array, timestamp = Date.now()) => {
    const canonical = ['v1', method, path, clientId, createHash('sha256').update(body).digest('hex'), String(timestamp)].join('\n')
    return {
      'X-Client-Id': clientId,
      'X-Timestamp': String(timestamp),
      'X-Signature': sign('sha256', Buffer.from(canonical), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
    }
  }
  return { point, headers }
}

describe('signed writes', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

  async function setupDevice() {
    const key = signer()
    const res = await enroll({ public_key: key.point, name: 'iPhone' })
    return { key, device: ((await res.json()) as { id: string }).id }
  }

  async function multipart(fields: Record<string, string>, images: Uint8Array[] = []) {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    for (const image of images) form.append('image[]', new Blob([image as BlobPart]), 'p.jpg')
    // A Response, unlike a Request, reports the boundary in its content type, read before the body.
    const res = new Response(form)
    const contentType = res.headers.get('content-type') ?? ''
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType }
  }

  async function send(
    d: { key: ReturnType<typeof signer>; device: string },
    topic: string,
    fields: Record<string, string>,
    images: Uint8Array[] = [],
    timestamp?: number,
    encoded?: { bytes: Uint8Array; contentType: string },
  ) {
    const path = `/v1/topics/${topic}/messages`
    const { bytes, contentType } = encoded ?? (await multipart(fields, images))
    return fetch(`${base}${path}`, {
      method: 'POST',
      body: bytes as unknown as BodyInit,
      headers: { 'X-Device': d.device, 'content-type': contentType, ...d.key.headers('POST', path, fields.client_id, bytes, timestamp) },
    })
  }

  test('a signed message is stored, written to the ledger, and handed to its agent with the ledger hash', async () => {
    const d = await setupDevice()
    const res = await send(d, '42', { text: 'run the tests', client_id: 'client-0001' })
    expect(res.status).toBe(201)
    const message = await res.json()
    expect(message).toMatchObject({ topic: '42', seq: 1, author: 'operator', origin: 'app', text: 'run the tests', client_id: 'client-0001', delivery: 'delivered' })
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(ledger.map(l => l.kind)).toEqual(['enroll', 'message'])
    expect(ledger[0]).toMatchObject({ device: d.device, name: 'iPhone', public_key: d.key.point })
    expect(ledger[1]).toMatchObject({ device: d.device, topic: '42', seq: 1, method: 'POST', path: '/v1/topics/42/messages', client_id: 'client-0001' })
    const signed = readFileSync(join(dir, 'signed-bodies', ledger[1].body_sha256))
    expect(createHash('sha256').update(signed).digest('hex')).toBe(ledger[1].body_sha256)
    const canonical = ['v1', ledger[1].method, ledger[1].path, ledger[1].client_id, ledger[1].body_sha256, String(ledger[1].timestamp)].join('\n')
    const key = createPublicKey({ key: Buffer.concat([SPKI_P256, Buffer.from(ledger[0].public_key, 'base64')]), format: 'der', type: 'spki' })
    expect(verify('sha256', Buffer.from(canonical), { key, dsaEncoding: 'der' }, Buffer.from(ledger[1].signature, 'base64'))).toBeTrue()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ topic: '42', deviceId: d.device, ledgerHash: ledger[1].hash })
  })

  test('a retry of the same bytes, newly signed, gets the first answer and delivers nothing again; another body under that id is refused', async () => {
    const d = await setupDevice()
    const encoded = await multipart({ text: 'once', client_id: 'client-0002' })
    const first = await (await send(d, '42', { client_id: 'client-0002' }, [], undefined, encoded)).json()
    const retry = await send(d, '42', { client_id: 'client-0002' }, [], Date.now() + 1_000, encoded)
    expect([retry.status, await retry.json()]).toEqual([201, first])
    expect(deliveries).toHaveLength(1)
    const other = await send(d, '42', { text: 'twice', client_id: 'client-0002' })
    expect([other.status, (await other.json()).error.code]).toEqual([409, 'client_id_reused'])
  })

  test('an unsigned, wrongly signed or stale write changes nothing', async () => {
    const d = await setupDevice()
    const stranger = signer()
    expect((await send({ key: stranger, device: d.device }, '42', { text: 'x', client_id: 'client-0003' })).status).toBe(401)
    expect((await send(d, '42', { text: 'x', client_id: 'client-0004' }, [], Date.now() - 200_000)).status).toBe(401)
    const { bytes, contentType } = await multipart({ text: 'x', client_id: 'client-0005' })
    expect((await fetch(`${base}/v1/topics/42/messages`, { method: 'POST', body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, 'content-type': contentType } })).status).toBe(400)
    expect(deliveries).toEqual([])
    expect(store.history('42', 10)).toEqual([])
  })

  test('images are kept as blobs and passed on; anything not JPEG or PNG is refused', async () => {
    const d = await setupDevice()
    const res = await send(d, '42', { text: '', client_id: 'client-0006' }, [JPEG])
    expect((await res.json()).blobs).toEqual([expect.objectContaining({ mime: 'image/jpeg', bytes: JPEG.length })])
    expect(deliveries[0].images).toEqual([{ bytes: JPEG, mime: 'image/jpeg' }])
    const bad = await send(d, '42', { text: 'x', client_id: 'client-0007' }, [new Uint8Array([1, 2, 3])])
    expect([bad.status, (await bad.json()).error.code]).toEqual([400, 'bad_image'])
  })

  test('a message the agent could not take is stored as failed, with the reason', async () => {
    const d = await setupDevice()
    deliverOutcome = { delivered: false, reason: 'the topic is locked to another harness' }
    const res = await send(d, '42', { text: 'hello', client_id: 'client-0008' })
    expect(await res.json()).toMatchObject({ delivery: 'failed', failure: 'the topic is locked to another harness' })
  })

  test('an unknown topic is refused; a client id that does not match its header is refused', async () => {
    const d = await setupDevice()
    expect((await send(d, '999', { text: 'x', client_id: 'client-0009' })).status).toBe(404)
    const path = '/v1/topics/42/messages'
    const { bytes, contentType } = await multipart({ text: 'x', client_id: 'client-other' })
    const res = await fetch(`${base}${path}`, { method: 'POST', body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, 'content-type': contentType, ...d.key.headers('POST', path, 'client-0010', bytes) } })
    expect((await res.json()).error.code).toBe('client_id_mismatch')
  })

  test('read markers are signed, shared, and never move back', async () => {
    const d = await setupDevice()
    const mark = async (seq: number, clientId: string) => {
      const path = '/v1/topics/42/read'
      const bytes = new TextEncoder().encode(JSON.stringify({ seq }))
      return (await fetch(`${base}${path}`, { method: 'POST', body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, ...d.key.headers('POST', path, clientId, bytes) } })).json()
    }
    expect(await mark(5, 'read-00001')).toEqual({ topic: '42', read_seq: 5 })
    expect(await mark(3, 'read-00002')).toEqual({ topic: '42', read_seq: 5 })
  })

  test('a device sets its own push token with the contract\'s body, signed; never another device\'s', async () => {
    const d = await setupDevice()
    const other = await setupDevice()
    const body = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'conductor-v1', 'device-push-request.json'))
    const put = (target: string, bytes: Uint8Array, clientId: string) => {
      const path = `/v1/devices/${target}/push`
      return fetch(`${base}${path}`, { method: 'PUT', body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, ...d.key.headers('PUT', path, clientId, bytes) } })
    }
    const res = await put(d.device, new Uint8Array(body), 'push-00001')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: d.device, apns_token: 'a1b2c3d4e5f6', apns_env: 'production' })
    expect((await put(other.device, new Uint8Array(body), 'push-00002')).status).toBe(403)
    expect(store.device(other.device)?.apnsToken).toBeNull()
    const tokenAlone = new TextEncoder().encode('{"apns_token":"abcd","apns_env":null}')
    expect((await put(d.device, tokenAlone, 'push-00003')).status).toBe(400)
    const off = new TextEncoder().encode('{"apns_token":null,"apns_env":null}')
    expect(await (await put(d.device, off, 'push-00004')).json()).toMatchObject({ apns_token: null })
    expect(store.pushTargets()).toEqual([])
  })

  test('a route switch and a command are signed, recorded in the ledger first, and answered with their result', async () => {
    const d = await setupDevice()
    const act = (method: 'PUT' | 'POST', path: string, body: unknown, clientId: string) => {
      const bytes = new TextEncoder().encode(JSON.stringify(body))
      return fetch(`${base}${path}`, { method, body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, ...d.key.headers(method, path, clientId, bytes) } })
    }
    const routed = await act('PUT', '/v1/topics/42/route', { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' }, 'route-00001')
    expect([routed.status, await routed.json()]).toEqual([200, readJson('route-result.json', { state: 'applied' })])
    const relaunched = await act('POST', '/v1/topics/42/commands', { name: 'relaunch' }, 'cmd-000001')
    expect([relaunched.status, (await relaunched.json()).name]).toEqual([200, 'relaunch'])
    expect((await act('POST', '/v1/topics/nope/commands', { name: 'relaunch' }, 'cmd-000002')).status).toBe(404)
    expect(controlled).toEqual(['route 42 claude-opus-5-5 high', 'relaunch 42'])
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(ledger.map(l => l.kind)).toEqual(['enroll', 'route', 'command'])
    expect(ledger[1]).toMatchObject({ device: d.device, topic: '42', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', method: 'PUT', path: '/v1/topics/42/route', client_id: 'route-00001' })
    expect(ledger[2]).toMatchObject({ name: 'relaunch', method: 'POST', client_id: 'cmd-000001' })
    expect(brokenLine(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'))).toBeUndefined()
    const unsigned = await fetch(`${base}/v1/topics/42/commands`, { method: 'POST', body: '{"name":"relaunch"}', headers: { 'X-Device': d.device } })
    expect(unsigned.status).toBe(400)
  })

  test('the palette, the catalog and usage are reads', async () => {
    const d = await setupDevice()
    expect(await (await get('/v1/commands', d.device)).json()).toEqual(readJson('commands.json'))
    expect((await (await get('/v1/routes', d.device)).json()).providers[0].models[0]).toMatchObject({ id: 'claude-opus-5-5', default_effort: 'xhigh' })
    expect(await (await get('/v1/usage', d.device)).json()).toEqual({ providers: [] })
  })

  test('a topic is created, renamed, muted and pinned by signed writes, each in the ledger, answered with the topic now', async () => {
    const d = await setupDevice()
    const act = (method: 'POST' | 'PATCH', path: string, body: unknown, clientId: string) => {
      const bytes = new TextEncoder().encode(JSON.stringify(body))
      return fetch(`${base}${path}`, { method, body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, ...d.key.headers(method, path, clientId, bytes) } })
    }
    const created = await act('POST', '/v1/topics', { name: 'research' }, 'topic-00001')
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ id: '501', name: 'research', pinned: false, muted: false })
    const patched = await act('PATCH', '/v1/topics/42', { name: 'ci', muted: true, pinned: true }, 'topic-00002')
    expect([patched.status, await patched.json()]).toEqual([200, expect.objectContaining({ id: '42', name: 'ci', muted: true, pinned: true })])
    expect((await act('PATCH', '/v1/topics/42', { muted: 'no' }, 'topic-00003')).status).toBe(400)
    expect((await act('PATCH', '/v1/topics/nope', { muted: true }, 'topic-00004')).status).toBe(404)
    const topicsNow = (await (await get('/v1/topics', d.device)).json()).topics as Array<{ id: string; muted: boolean }>
    expect(topicsNow.find(t => t.id === '42')?.muted).toBeTrue()
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(ledger.filter(l => l.kind === 'topic').map(l => [l.action, l.topic ?? null, l.name ?? null])).toEqual([
      ['create', null, 'research'], ['patch', '42', 'ci'], ['patch', '42', null],
    ])
  })

  test('a secret from the app is stored and listed by name; its value is in no ledger entry, log line or kept answer', async () => {
    const d = await setupDevice()
    const VALUE = 'sk-live-THIS-MUST-NOT-LEAK-0123456789'
    const act = (method: 'POST' | 'DELETE', path: string, body: unknown, clientId: string) => {
      const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body))
      return fetch(`${base}${path}`, { method, body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, ...d.key.headers(method, path, clientId, bytes) } })
    }
    const stored = await act('POST', '/v1/secrets', { name: 'service-token', value: VALUE, topic: '42' }, 'secret-0001')
    expect([stored.status, Object.keys(await stored.json()).sort()]).toEqual([200, Object.keys(readJson('secret-stored.json')).sort()])
    expect((await act('POST', '/v1/secrets', { name: 'service-token', value: 'other' }, 'secret-0002')).status).toBe(409)
    expect((await act('POST', '/v1/secrets', { name: '../etc', value: 'x' }, 'secret-0003')).status).toBe(400)
    const listedSecrets = await (await get('/v1/secrets', d.device)).json()
    const secretFixture = (readJson('secrets-list.json').secrets as Array<Record<string, unknown>>)[0]
    expect(Object.keys(listedSecrets.secrets[0]).sort()).toEqual(Object.keys(secretFixture).sort())
    expect(listedSecrets.secrets.map((x: { name: string }) => x.name)).toEqual(['service-token'])
    expect((await act('DELETE', '/v1/secrets/service-token', undefined, 'secret-0004')).status).toBe(200)
    expect((await act('DELETE', '/v1/secrets/service-token', undefined, 'secret-0005')).status).toBe(404)
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
    expect(ledger.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.kind === 'secret').map(l => [l.action, l.name]))
      .toEqual([['store', 'service-token'], ['store', 'service-token'], ['store', '../etc'], ['delete', 'service-token'], ['delete', 'service-token']])
    expect(ledger).not.toContain(VALUE)
    expect(logged.join('\n')).not.toContain(VALUE)
    expect(store.earlierWrite(d.device, 'secret-0001')?.response).not.toContain(VALUE)
  })

  test('a reminder from the app is set on a listed topic, listed soonest first, and cancelled by id', async () => {
    const d = await setupDevice()
    const act = (method: 'POST' | 'DELETE', path: string, body: unknown, clientId: string) => {
      const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body))
      return fetch(`${base}${path}`, { method, body: bytes as unknown as BodyInit, headers: { 'X-Device': d.device, ...d.key.headers(method, path, clientId, bytes) } })
    }
    const set = await act('POST', '/v1/topics/42/reminders', { at: '2026-11-02T09:00:00.000-05:00', text: 'stretch' }, 'remind-0001')
    expect([set.status, await set.json()]).toEqual([200, readJson('reminder.json', { id: 'rm_1', topic: '42', created_at: '2026-11-01T20:25:37.123Z' })])
    expect((await act('POST', '/v1/topics/42/reminders', { at: '2026-11-02T09:00', text: 'no zone' }, 'remind-0002')).status).toBe(400)
    expect((await act('POST', '/v1/topics/nope/reminders', { at: '2026-11-02T09:00:00Z', text: 'x' }, 'remind-0003')).status).toBe(404)
    expect(await (await get('/v1/topics/42/reminders', d.device)).json()).toEqual({ reminders: [expect.objectContaining({ id: 'rm_1' })] })
    expect((await act('DELETE', '/v1/reminders/rm_1', undefined, 'remind-0004')).status).toBe(200)
    expect((await act('DELETE', '/v1/reminders/rm_1', undefined, 'remind-0005')).status).toBe(404)
    expect(await (await get('/v1/topics/42/reminders', d.device)).json()).toEqual({ reminders: [] })
  })
})

test('open approvals are listed, streamed as they open and resolve, and counted on their topic', async () => {
  const device = await enrolled()
  const frames: Array<Record<string, unknown>> = []
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/stream`, { headers: { 'X-Device': device } } as never)
  ws.onmessage = e => frames.push(JSON.parse(String(e.data)))
  await new Promise(resolve => (ws.onopen = resolve))
  ws.send(JSON.stringify({ type: 'hello' }))
  await new Promise(resolve => setTimeout(resolve, 50))
  const a = store.openApproval({ topic: '42', kind: 'permission', prompt: 'approve Bash: ls', choices: [{ id: '1', label: 'Yes', role: 'approve' }] })
  const listedNow = await (await get('/v1/approvals?state=open', device)).json()
  expect(Object.keys(listedNow).sort()).toEqual(Object.keys(readJson('approvals-response.json')).sort())
  expect(listedNow.approvals.map((x: { id: string }) => x.id)).toEqual([a.id])
  expect((await (await get('/v1/topics', device)).json()).topics.find((t: { id: string }) => t.id === '42').pending_approvals).toBe(1)
  store.resolveApproval(a.id, { choice: null, by: null, at: '2026-11-01T22:00:00.000Z' })
  await new Promise(resolve => setTimeout(resolve, 50))
  ws.close()
  expect(frames.filter(f => f.type === 'approval').map(f => (f.approval as { resolved: unknown }).resolved === null)).toEqual([true, false])
  expect((await (await get('/v1/approvals', device)).json()).approvals).toEqual([])
  expect((await get('/v1/approvals?state=all', device)).status).toBe(400)
})

function readJson(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const f = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'docs', 'conductor-v1', name), 'utf8'))
  return { ...f, ...over }
}

