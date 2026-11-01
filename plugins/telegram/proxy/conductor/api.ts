// The conductor's API, version 1 (docs/conductor.md): every request is admitted
// by the tailnet identity of its peer address, then by a device enrolled from
// that same node. This step serves enrollment, the reads and the stream.
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { admit } from './domain/identity'
import type { IdentityPolicy, Peer } from './domain/identity'
import type { StoredEvent, StoredMessage } from './domain/message'
import { devicePublicKey } from './domain/signing'
import { checkSignedWrite, replay } from './domain/write-auth'
import type { SignedWrite } from './domain/write-auth'
import type { Ledger } from './ledger'
import type { ConductorStore } from './sqlite-store'
import { topicTracker } from './topic-tracker'
import { wireDevice, wireMessage, wireScreen, wireTopic } from './wire'
import type { AgentState, Device, ScreenView, TopicView } from './wire'

export type TopicSummary = { id: string; name: string; kind: string; title: string | null; route: TopicView['route']; state: AgentState }

export type AppImage = { bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' }

/** Hands an operator message sent from the app to its topic's agent, as a turn carrying the ledger entry's hash. */
export type DeliverAppMessage = (input: {
  topic: string
  message: StoredMessage
  images: readonly AppImage[]
  ledgerHash: string
  deviceId: string
}) => Promise<{ delivered: true } | { delivered: false; reason: string }>

export type ConductorApiPorts = {
  store: ConductorStore
  ledger: Ledger
  policy: IdentityPolicy
  /** Who the local Tailscale client says the address belongs to. */
  whois: (address: string) => Promise<Peer>
  topics: () => TopicSummary[]
  /** An operator-facing notice, outside the API. */
  notify: (text: string) => void
  deliver: DeliverAppMessage
  /** A topic's screen now; undefined for a topic with none to show. Absent, no topic has a screen. */
  screen?: (topic: string) => Promise<ScreenView | undefined>
  /** Calls back whenever something the topic list reports may have changed. */
  watchTopics?: (changed: () => void) => void
  log: (message: string) => void
  version: string
  now?: () => number
}

type SocketData = { deviceId: string; ready: boolean; screens: Set<string> }

const HEARTBEAT_MS = 20_000
const REPLAY_PAGE = 500
/** Topic changes the list cannot announce (the lifecycle's own) are found by looking this often. */
const TOPIC_SWEEP_MS = 2_000
/** A watched screen is read at most twice a second. */
const SCREEN_MS = 500

const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status })

const TEXT_MAX_BYTES = 64 * 1024
const IMAGES_MAX = 10
const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** The app sends JPEG or PNG: the model reads neither HEIC nor anything else. */
function imageMime(bytes: Uint8Array): AppImage['mime'] | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  return undefined
}

/** A device's APNs token and the environment it belongs to; no token means no push. */
function pushFields(body: Record<string, unknown> | null): Pick<Device, 'apnsToken' | 'apnsEnv'> | Response {
  const apnsToken = body?.apns_token ?? null
  const apnsEnv = body?.apns_env ?? null
  if (apnsToken !== null && (typeof apnsToken !== 'string' || !/^[0-9a-fA-F]{1,200}$/.test(apnsToken))) {
    return fail(400, 'bad_apns_token', 'apns_token must be hex')
  }
  if (apnsEnv !== null && apnsEnv !== 'sandbox' && apnsEnv !== 'production') return fail(400, 'bad_apns_env', 'apns_env must be sandbox or production')
  if (apnsToken !== null && apnsEnv === null) return fail(400, 'bad_apns_env', 'a token needs its apns_env')
  return { apnsToken, apnsEnv }
}

export function createConductorApi(ports: ConductorApiPorts) {
  const { store } = ports
  const now = ports.now ?? Date.now
  const sockets = new Set<ServerWebSocket<SocketData>>()
  const inFlight = new Map<string, Promise<Response>>()
  const tracker = topicTracker({ topics: ports.topics, store, now })

  function topicView(t: TopicSummary): TopicView {
    const { last, unread, readSeq } = store.summary(t.id)
    return {
      ...t,
      pinned: t.id === 'general',
      muted: false,
      stateSince: tracker.since(t.id),
      unread,
      readSeq,
      pendingApprovals: 0,
      lastMessage: last ? { preview: last.text.slice(0, 200), author: last.author, at: last.at } : null,
    }
  }

  /** The event as the stream sends it; a topic event carries the topic as it is now, and none for a topic no longer listed. */
  function wireEvent(event: StoredEvent): Record<string, unknown> | undefined {
    if (event.type === 'message') return { type: 'message', cursor: event.cursor, message: wireMessage(event.message) }
    const listed = ports.topics().find(t => t.id === event.topic)
    return listed ? { type: 'topic', cursor: event.cursor, topic: wireTopic(topicView(listed)) } : undefined
  }

  // Screens: one reader per watched topic, sending only what changed.
  const screens = new Map<string, { timer: ReturnType<typeof setInterval>; last?: string; reading: boolean }>()

  const screenWatchers = (topic: string) => [...sockets].filter(s => s.data.screens.has(topic))

  function noScreen(socket: ServerWebSocket<SocketData>, topic: string) {
    socket.data.screens.delete(topic)
    socket.send(JSON.stringify({ type: 'error', screen: topic, error: { code: 'no_screen', message: 'this topic has no screen to show' } }))
  }

  function unwatch(topic: string) {
    if (screenWatchers(topic).length) return
    clearInterval(screens.get(topic)?.timer)
    screens.delete(topic)
  }

  async function readScreen(topic: string, force = false) {
    const watching = screens.get(topic)
    if (!watching || watching.reading || !ports.screen) return
    watching.reading = true
    try {
      const screen = await ports.screen(topic)
      if (!screen) {
        for (const socket of screenWatchers(topic)) noScreen(socket, topic)
        unwatch(topic)
        return
      }
      const frame = JSON.stringify({ type: 'screen', screen: wireScreen(screen) })
      if (!force && frame === watching.last) return
      watching.last = frame
      for (const socket of screenWatchers(topic)) socket.send(frame)
    } finally {
      watching.reading = false
    }
  }

  function watchScreen(socket: ServerWebSocket<SocketData>, topic: unknown) {
    if (typeof topic !== 'string' || !ports.screen || !ports.topics().some(t => t.id === topic)) {
      noScreen(socket, String(topic))
      return
    }
    socket.data.screens.add(topic)
    const watching = screens.get(topic)
    if (watching?.last) socket.send(watching.last)
    if (watching) return
    screens.set(topic, { timer: setInterval(() => void readScreen(topic), SCREEN_MS), reading: false })
    void readScreen(topic, true)
  }

  store.onEvent(event => {
    const wire = wireEvent(event)
    if (wire) {
      const frame = JSON.stringify(wire)
      for (const socket of sockets) if (socket.data.ready) socket.send(frame)
    }
    // Every state change is also a fresh screen.
    if (event.type === 'topic' && screens.has(event.topic)) void readScreen(event.topic, true)
  })
  const heartbeat = setInterval(() => {
    for (const socket of sockets) if (socket.data.ready) socket.send('{"type":"heartbeat"}')
  }, HEARTBEAT_MS)

  tracker.refresh()
  let refreshQueued = false
  ports.watchTopics?.(() => {
    if (refreshQueued) return
    refreshQueued = true
    setTimeout(() => {
      refreshQueued = false
      tracker.refresh()
    }, 50)
  })
  const sweep = setInterval(() => tracker.refresh(), TOPIC_SWEEP_MS)

  /** The device a read names, if it was enrolled from the node now calling. */
  function deviceFor(req: Request, nodeId: string): Device | undefined {
    const device = store.device(req.headers.get('x-device') ?? '')
    return device && device.nodeId === nodeId ? device : undefined
  }

  async function enroll(req: Request, nodeId: string): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const publicKey = typeof body?.public_key === 'string' ? body.public_key : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!devicePublicKey(publicKey)) return fail(400, 'bad_public_key', 'public_key must be a base64 P-256 uncompressed point')
    if (!name || name.length > 64) return fail(400, 'bad_name', 'name must be 1 to 64 characters')
    const push = pushFields(body)
    if (push instanceof Response) return push
    const { device, created } = store.enroll({ name, publicKey, nodeId, ...push })
    if (device.nodeId !== nodeId) return fail(409, 'device_on_another_node', 'this key is enrolled from another node')
    if (created) {
      ports.ledger.append({ kind: 'enroll', device: device.id, name, node: nodeId, public_key: publicKey })
      ports.notify(`📱 A device enrolled with the conductor: ${name}. If you did not just enroll it, revoke it.`)
      ports.log(`conductor: enrolled device ${device.id} (${name}) from node ${nodeId}`)
    }
    return Response.json(wireDevice(device), { status: created ? 201 : 200 })
  }

  async function setPush(device: Device, target: string, body: Uint8Array): Promise<Response> {
    if (target !== device.id) return fail(403, 'not_this_device', 'a device sets only its own push token')
    let fields: Record<string, unknown> | null
    try {
      fields = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return fail(400, 'bad_json', 'the body must be JSON')
    }
    const push = pushFields(fields)
    if (push instanceof Response) return push
    const updated = store.setPush(device.id, push.apnsToken, push.apnsEnv)
    ports.log(`conductor: ${device.id} ${push.apnsToken ? `set its ${push.apnsEnv} push token` : 'turned push off'}`)
    return Response.json(wireDevice(updated ?? device))
  }

  /**
   * Verifies a write, answers a retry with the first result, and keeps this
   * answer for the next retry. Two retries arriving together share one run.
   */
  async function signedWrite(
    req: Request,
    url: URL,
    device: Device,
    handle: (body: Uint8Array, write: SignedWrite) => Promise<Response>,
  ): Promise<Response> {
    const body = new Uint8Array(await req.arrayBuffer())
    const write = checkSignedWrite({ headers: req.headers, method: req.method, pathWithQuery: url.pathname + url.search, body, publicKey: device.publicKey, now: now() })
    if ('code' in write) return fail(write.status, write.code, write.message)
    const key = `${device.id} ${write.clientId}`
    const running = inFlight.get(key)
    if (running) return (await running).clone()
    const earlier = replay(store.earlierWrite(device.id, write.clientId), write.bodySha256)
    if (earlier) {
      return 'code' in earlier
        ? fail(earlier.status, earlier.code, earlier.message)
        : new Response(earlier.response, { status: earlier.status, headers: { 'content-type': 'application/json' } })
    }
    const run = handle(body, write).then(async res => {
      if (res.status < 500) store.recordWrite(device.id, write.clientId, write.bodySha256, res.status, await res.clone().text())
      return res
    })
    inFlight.set(key, run)
    try {
      return (await run).clone()
    } finally {
      inFlight.delete(key)
    }
  }

  async function sendMessage(req: Request, topic: string, device: Device, body: Uint8Array, write: SignedWrite): Promise<Response> {
    if (!ports.topics().some(t => t.id === topic)) return fail(404, 'not_found', 'no such topic')
    let form: FormData
    try {
      const contentType = req.headers.get('content-type') ?? ''
      form = await new Response(new Blob([body as BlobPart], { type: contentType }), { headers: { 'content-type': contentType } }).formData()
    } catch {
      return fail(400, 'bad_form', 'the body must be multipart/form-data')
    }
    if (form.get('client_id') !== write.clientId) return fail(400, 'client_id_mismatch', 'client_id must equal X-Client-Id')
    const text = String(form.get('text') ?? '')
    if (new TextEncoder().encode(text).length > TEXT_MAX_BYTES) return fail(413, 'text_too_long', 'text is at most 64 KB')
    const files = form.getAll('image[]').filter((f): f is File => f instanceof File)
    if (files.length > IMAGES_MAX) return fail(413, 'too_many_images', 'at most 10 images')
    const images: AppImage[] = []
    for (const file of files) {
      if (file.size > IMAGE_MAX_BYTES) return fail(413, 'image_too_large', 'an image is at most 20 MB')
      const bytes = new Uint8Array(await file.arrayBuffer())
      const mime = imageMime(bytes)
      if (!mime) return fail(400, 'bad_image', 'images must be JPEG or PNG')
      images.push({ bytes, mime })
    }
    if (!text.trim() && images.length === 0) return fail(400, 'empty', 'a message needs text or an image')
    const replyTo = form.get('reply_to')
    if (typeof replyTo === 'string' && replyTo && store.messageById(replyTo)?.topic !== topic) {
      return fail(400, 'bad_reply_to', 'reply_to must name a message in this topic')
    }

    const message = store.append({
      topic, author: 'operator', origin: 'app', text, format: 'plain',
      blobs: images.map(image => store.addBlob(image.bytes, image.mime)),
      ...(typeof replyTo === 'string' && replyTo ? { replyTo } : {}),
      clientId: write.clientId, delivery: 'accepted',
    })
    ports.ledger.keepSignedBody(body)
    const ledgerHash = ports.ledger.append({
      kind: 'message', device: device.id, topic, seq: message.seq, method: write.method, path: write.path,
      client_id: write.clientId, body_sha256: write.bodySha256, signature: write.signature, timestamp: write.timestamp,
    })
    const outcome = await ports.deliver({ topic, message, images, ledgerHash, deviceId: device.id })
    const final = outcome.delivered
      ? store.setDelivery(message.id, 'delivered')
      : store.setDelivery(message.id, 'failed', outcome.reason)
    return Response.json(wireMessage(final ?? message), { status: 201 })
  }

  async function markRead(topic: string, body: Uint8Array): Promise<Response> {
    let seq: unknown
    try {
      seq = JSON.parse(new TextDecoder().decode(body)).seq
    } catch {
      return fail(400, 'bad_json', 'the body must be JSON')
    }
    if (!Number.isInteger(seq) || (seq as number) < 0) return fail(400, 'bad_seq', 'seq must be a whole number')
    return Response.json({ topic, read_seq: store.markRead(topic, seq as number) })
  }

  function topics(): Response {
    const listed = ports.topics().map(topicView)
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
      return server.upgrade(req, { data: { deviceId: device.id, ready: false, screens: new Set<string>() } })
        ? undefined
        : fail(400, 'not_websocket', 'the stream is a WebSocket')
    }
    const write = url.pathname.match(/^\/v1\/topics\/([^/]+)\/(messages|read)$/)
    if (req.method === 'POST' && write) {
      const topic = decodeURIComponent(write[1])
      return signedWrite(req, url, device, (body, signed) =>
        write[2] === 'messages' ? sendMessage(req, topic, device, body, signed) : markRead(topic, body))
    }
    const pushPath = url.pathname.match(/^\/v1\/devices\/([^/]+)\/push$/)
    if (req.method === 'PUT' && pushPath) {
      return signedWrite(req, url, device, body => setPush(device, decodeURIComponent(pushPath[1]), body))
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
        for (const event of page) {
          const wire = wireEvent(event)
          if (wire) socket.send(JSON.stringify(wire))
        }
        cursor = page[page.length - 1].cursor
      }
    }
    socket.data.ready = true
    socket.send(JSON.stringify({ type: 'ready', cursor: store.latestCursor() }))
  }

  const websocket: WebSocketHandler<SocketData> = {
    open: socket => void sockets.add(socket),
    close(socket) {
      sockets.delete(socket)
      for (const topic of socket.data.screens) unwatch(topic)
    },
    message(socket, raw) {
      let frame: { type?: unknown; since?: unknown; screen?: unknown }
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (frame.type === 'hello') hello(socket, frame.since)
      else if (frame.type === 'subscribe') watchScreen(socket, frame.screen)
      else if (frame.type === 'unsubscribe' && typeof frame.screen === 'string') {
        socket.data.screens.delete(frame.screen)
        unwatch(frame.screen)
      }
    },
  }

  return {
    fetch,
    websocket,
    stop() {
      clearInterval(heartbeat)
      clearInterval(sweep)
      for (const { timer } of screens.values()) clearInterval(timer)
      screens.clear()
    },
  }
}
