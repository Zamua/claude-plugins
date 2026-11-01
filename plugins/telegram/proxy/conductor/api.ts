// The conductor's API, version 1 (docs/conductor.md): every request is admitted
// by the tailnet identity of its peer address, then by a device enrolled from
// that same node. This step serves enrollment, the reads and the stream.
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { admit } from './domain/identity'
import type { IdentityPolicy, Peer } from './domain/identity'
import type { StoredEvent } from './domain/message'
import { devicePublicKey, sha256Hex } from './domain/signing'
import type { Ledger } from './ledger'
import type { ConductorStore } from './sqlite-store'
import { wireDevice, wireMessage, wireTopic } from './wire'
import type { AgentState, Device, TopicView } from './wire'

export type TopicSummary = { id: string; name: string; kind: string; route: TopicView['route']; state: AgentState }

export type ConductorApiPorts = {
  store: ConductorStore
  ledger: Ledger
  policy: IdentityPolicy
  /** Who the local Tailscale client says the address belongs to. */
  whois: (address: string) => Promise<Peer>
  topics: () => TopicSummary[]
  /** An operator-facing notice, outside the API. */
  notify: (text: string) => void
  log: (message: string) => void
  version: string
}

type SocketData = { deviceId: string; ready: boolean }

const HEARTBEAT_MS = 20_000
const REPLAY_PAGE = 500

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status })

const wireEvent = (event: StoredEvent) => ({ type: event.type, cursor: event.cursor, message: wireMessage(event.message) })

export function createConductorApi(ports: ConductorApiPorts) {
  const { store } = ports
  const sockets = new Set<ServerWebSocket<SocketData>>()

  store.onEvent(event => {
    const frame = JSON.stringify(wireEvent(event))
    for (const socket of sockets) if (socket.data.ready) socket.send(frame)
  })
  const heartbeat = setInterval(() => {
    for (const socket of sockets) if (socket.data.ready) socket.send('{"type":"heartbeat"}')
  }, HEARTBEAT_MS)

  /** The device a read names, if it was enrolled from the node now calling. */
  function deviceFor(req: Request, nodeId: string): Device | undefined {
    const device = store.device(req.headers.get('x-device') ?? '')
    return device && device.nodeId === nodeId ? device : undefined
  }

  async function enroll(req: Request, nodeId: string): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const publicKey = typeof body?.public_key === 'string' ? body.public_key : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const apnsEnv = body?.apns_env ?? null
    const apnsToken = body?.apns_token ?? null
    if (!devicePublicKey(publicKey)) return fail(400, 'bad_public_key', 'public_key must be a base64 P-256 uncompressed point')
    if (!name || name.length > 64) return fail(400, 'bad_name', 'name must be 1 to 64 characters')
    if (apnsEnv !== null && apnsEnv !== 'sandbox' && apnsEnv !== 'production') return fail(400, 'bad_apns_env', 'apns_env must be sandbox or production')
    if (apnsToken !== null && (typeof apnsToken !== 'string' || !/^[0-9a-fA-F]{1,200}$/.test(apnsToken))) {
      return fail(400, 'bad_apns_token', 'apns_token must be hex')
    }
    const { device, created } = store.enroll({ name, publicKey, nodeId, apnsToken, apnsEnv })
    if (device.nodeId !== nodeId) return fail(409, 'device_on_another_node', 'this key is enrolled from another node')
    if (created) {
      ports.ledger.append({ kind: 'enroll', device: device.id, node: nodeId, public_key_sha256: sha256Hex(publicKey) })
      ports.notify(`📱 A device enrolled with the conductor: ${name}. If you did not just enroll it, revoke it.`)
      ports.log(`conductor: enrolled device ${device.id} (${name}) from node ${nodeId}`)
    }
    return Response.json(wireDevice(device), { status: created ? 201 : 200 })
  }

  function topics(): Response {
    const listed = ports.topics().map(t => {
      const { last, unread, readSeq } = store.summary(t.id)
      return {
        ...t,
        title: null,
        pinned: t.id === 'general',
        muted: false,
        stateSince: null,
        unread,
        readSeq,
        pendingApprovals: 0,
        lastMessage: last ? { preview: last.text.slice(0, 200), author: last.author, at: last.at } : null,
      }
    })
    listed.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessage?.at ?? '').localeCompare(a.lastMessage?.at ?? ''))
    return Response.json({ cursor: store.latestCursor(), topics: listed.map(wireTopic) })
  }

  function history(topic: string, url: URL): Response {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const before = url.searchParams.get('before_seq')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, 'bad_limit', 'limit must be 1 to 100')
    if (before !== null && !/^\d+$/.test(before)) return fail(400, 'bad_before_seq', 'before_seq must be a number')
    const messages = store.history(topic, limit, before === null ? undefined : Number(before))
    return Response.json({ cursor: store.latestCursor(), messages: messages.map(m => wireMessage(m)) })
  }

  function blob(id: string): Response {
    const found = store.blobPath(id)
    return found ? new Response(Bun.file(found.path), { headers: { 'content-type': found.mime } }) : fail(404, 'not_found', 'no such blob')
  }

  async function fetch(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(req.url)
    const address = server.requestIP(req)?.address
    const admission = admit(address ? await ports.whois(address) : null, ports.policy)
    if (!admission.admitted) {
      ports.log(`conductor: refused ${req.method} ${url.pathname}: ${admission.refusal}`)
      return fail(403, admission.refusal, 'this peer may not use the conductor')
    }
    if (req.method === 'POST' && url.pathname === '/v1/devices') return enroll(req, admission.nodeId)

    const device = deviceFor(req, admission.nodeId)
    if (!device) return fail(401, 'unknown_device', 'X-Device names no device enrolled from this node')
    store.touchDevice(device.id)

    if (url.pathname === '/v1/stream') {
      return server.upgrade(req, { data: { deviceId: device.id, ready: false } })
        ? undefined
        : fail(400, 'not_websocket', 'the stream is a WebSocket')
    }
    if (req.method !== 'GET') return fail(405, 'method_not_allowed', 'not yet served')
    if (url.pathname === '/v1/me') return Response.json({ device: wireDevice(device), server_version: ports.version, contract: 'v1' })
    if (url.pathname === '/v1/topics') return topics()
    const messages = url.pathname.match(/^\/v1\/topics\/([^/]+)\/messages$/)
    if (messages) return history(decodeURIComponent(messages[1]), url)
    const blobPath = url.pathname.match(/^\/v1\/blobs\/(blob_[0-9a-f]+)$/)
    if (blobPath) return blob(blobPath[1])
    return fail(404, 'not_found', 'no such path')
  }

  /** Replays what the client missed and marks it live in one synchronous step, so no event falls between. */
  function hello(socket: ServerWebSocket<SocketData>, since: unknown) {
    if (since !== undefined) {
      if (!Number.isInteger(since) || (since as number) < 0 || (since as number) > store.latestCursor()) {
        socket.send('{"type":"reset"}')
        return
      }
      let cursor = since as number
      for (let page = store.eventsAfter(cursor, REPLAY_PAGE); page.length; page = store.eventsAfter(cursor, REPLAY_PAGE)) {
        for (const event of page) socket.send(JSON.stringify(wireEvent(event)))
        cursor = page[page.length - 1].cursor
      }
    }
    socket.data.ready = true
    socket.send(JSON.stringify({ type: 'ready', cursor: store.latestCursor() }))
  }

  const websocket: WebSocketHandler<SocketData> = {
    open: socket => void sockets.add(socket),
    close: socket => void sockets.delete(socket),
    message(socket, raw) {
      let frame: { type?: unknown; since?: unknown }
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (frame.type === 'hello') hello(socket, frame.since)
    },
  }

  return { fetch, websocket, stop: () => clearInterval(heartbeat) }
}
