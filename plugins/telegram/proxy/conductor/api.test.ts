import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConductorApi } from './api'
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
let api: ReturnType<typeof createConductorApi>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-api-'))
  store = new ConductorStore(dir)
  peer = PHONE
  notices = []
  api = createConductorApi({
    store,
    ledger: new Ledger(join(dir, 'ledger.jsonl')),
    policy: { selfNodeId: 'nSELF', operatorLogin: 'operator@example.com', allowedNodes: new Set(['nPHONE', 'nIPAD']) },
    whois: async () => peer,
    topics: () => [
      { id: 'general', name: 'General', kind: 'claude', route: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'xhigh' }, state: 'idle' },
      { id: '42', name: 'build', kind: 'claude', route: null, state: 'stopped' },
    ],
    notify: text => notices.push(text),
    log: () => {},
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

  test('the stream needs a device like any read', async () => {
    expect((await get('/v1/stream', 'dev_nope')).status).toBe(401)
  })
})
