// The loopback HTTP API the topic MCPs and hooks call: inbound long-polls, the
// permission relay, the topic directory, and the routes each context answers.
import { mayCreateProject } from '../topics/domain/session-tree'
import type { ChatPort } from '../chat/domain/chat-port'
import { PORT, PROXY_URL, SQUARE_TOPIC } from '../config'
import type { TopicHarness } from '../harness/domain/topic-harness'
import { log } from '../log'
import type { createReminders } from '../reminders/reminders'
import type { createRouting } from '../routing/routing'
import { acknowledge, requeueInflight } from '../shared/domain/inbox'
import { inboundModeForRoute } from '../shared/domain/inbound-delivery'
import { topicSlug } from '../shared/domain/topic-slug'
import type { createSquare } from '../square/square'
import { resumeNoticeTurn } from '../topics/lifecycle'
import { pendingPerms, prunePendingPerms } from '../topics/permissions'
import { currentRoute, getTopic, topics } from '../topics/state'
import type { createOutbound } from './outbound'
import type { TopicArchive } from '../topics/archive'
import type { TargetResult } from '../broker/domain/relaunch'
import type { ControlResult } from '../conductor/control'
import { BadRequest, parsePermissionRequest, parseTopicCreate, parseTopicKickoff, parseTopicList, parseTopicRename, parseTopicReparent, parseTopicRoute } from './requests'
import { acknowledgedPoll, longPoll } from './long-poll'
import { json } from './response'
import { ROUTE } from './routes'

export type HttpPorts = {
  chat: Pick<ChatPort, 'send'>
  outbound: ReturnType<typeof createOutbound>
  /** Creates and registers a forum topic and gives its id. */
  createTopic: (name: string, harness: TopicHarness, by: string) => Promise<string>
  schedulePanePump: (topic: string, delayMs?: number) => void
  /** The running turn ended: a route change waiting for it applies now. */
  turnEnded: (topic: string) => void
  /** The resumed session received its resume notice. */
  noticeDelivered: (topic: string) => void
  routing: Pick<ReturnType<typeof createRouting>, 'handleRateLimit' | 'handleCapacity' | 'handleTurnFailed'>
  square: Pick<
    ReturnType<typeof createSquare>,
    'topicDirectory' | 'slugForTopic' | 'handleSquareTag' | 'handleSquareReply'
  >
  reminders: Pick<ReturnType<typeof createReminders>, 'handleRemind' | 'handleListReminders' | 'handleCancelReminder'>
  /** When Telegram polling last started, or null while it is down. */
  pollingSince: () => number | null
  archive: TopicArchive
  /** Starts or wakes a topic's session for general without posting to the operator. */
  kickoff: (topic: string, prompt?: string) => { topic: string; outcome: string; reason?: string }
  /** Relaunch and route change for the Crook backend; absent while the conductor's ledger is off. */
  topicControl?: {
    relaunch: (topics: string[]) => Promise<TargetResult[]>
    route: (topic: string, choice: unknown) => Promise<ControlResult>
    routes: () => Record<string, unknown>
  }
}

export function createHttpServer(ports: HttpPorts) {
  const { chat, outbound, createTopic, schedulePanePump, turnEnded, noticeDelivered, routing, square, reminders } = ports

  function handlePoll(url: URL, signal: AbortSignal): Promise<Response> {
    const topic = url.searchParams.get('topic') ?? 'general'
    const st = getTopic(topic)
    // An MCP that acknowledges sends `ack` on every poll, empty when it holds
    // nothing; a reader that does not gets back whatever was left in flight.
    const ack = url.searchParams.get('ack')
    if (ack === null) requeueInflight(st)
    else acknowledge(st, ack)
    // Claude Code rejects Channel notifications under custom provider/API
    // billing. A stale MCP from an older launch may still call /poll, so never
    // let it drain a proxied route's queue. The pane pump owns that ingress.
    if (inboundModeForRoute(currentRoute(st)) === 'pane') {
      schedulePanePump(topic)
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    // A polling Claude has completed its previous turn, so this is the safe
    // boundary for a route change that was requested while it was busy. Return
    // 204 to the old process after restarting; the resumed process polls again.
    if (st.routing.pending) {
      turnEnded(topic)
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    if (st.routing.resumeNotice) {
      const content = st.routing.resumeNotice
      noticeDelivered(topic)
      return Promise.resolve(json(resumeNoticeTurn(topic, content)))
    }
    return ack === null ? longPoll(st.queue, st.waiters, signal) : acknowledgedPoll(st, ack, signal)
  }

  // A topic-MCP forwards a harness permission prompt here. Remember it against
  // the origin topic and post an approve/deny prompt into that topic's thread.
  async function handlePermissionRequest(req: Request): Promise<Response> {
    const { topic, requestId, tool, input } = parsePermissionRequest(await req.json())

    prunePendingPerms()
    pendingPerms.set(requestId, { topic, createdAt: Date.now() })

    const trimmed = input.length > 500 ? input.slice(0, 500) + '…' : input
    const preview = trimmed ? `\n\n${trimmed}` : ''
    const text =
      `🔐 Permission: ${tool}${preview}\n\n` +
      `Tap a button, or reply "yes ${requestId}" to allow / "no ${requestId}" to deny.`
    await chat.send(topic, {
      text,
      actions: [[
        { label: '✅ Allow', intent: { kind: 'permission', behavior: 'allow', requestId } },
        { label: '❌ Deny', intent: { kind: 'permission', behavior: 'deny', requestId } },
      ]],
    })
    return json({ ok: true })
  }

  function handlePermissionPoll(url: URL, signal: AbortSignal): Promise<Response> {
    const st = getTopic(url.searchParams.get('topic') ?? 'general')
    return longPoll(st.permQueue, st.permWaiters, signal)
  }

  async function handleTopicCreate(req: Request): Promise<Response> {
    const { name, harness, by } = parseTopicCreate(await req.json())
    // The calling topic is the agent's own word for itself until the broker can prove it.
    if (by !== undefined && !mayCreateProject(by)) {
      return json({ error: 'only the root session makes projects; a coordinator spawns workers inside its own' }, 403)
    }
    const topic = await createTopic(name, harness, by ?? 'proxy')
    return json({
      topic,
      thread_id: Number(topic),
      name,
      harness,
      slug: harness === 'claude' ? square.slugForTopic(topic) : topicSlug(name),
    })
  }

  function handleHealth(): Response {
    const since = ports.pollingSince()
    return json({
      ok: true,
      topics: [...topics.keys()],
      port: PORT,
      polling: since != null,
      polling_since: since != null ? new Date(since).toISOString() : null,
    })
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const get = req.method === 'GET'
    const post = req.method === 'POST'
    switch (url.pathname) {
      case ROUTE.poll: if (get) return handlePoll(url, req.signal); break
      case ROUTE.permissionPoll: if (get) return handlePermissionPoll(url, req.signal); break
      case ROUTE.health: if (get) return handleHealth(); break
      case ROUTE.rateLimit: if (post) return routing.handleRateLimit(req); break
      case ROUTE.capacity: if (post) return routing.handleCapacity(req); break
      case ROUTE.turnFailed: if (post) return routing.handleTurnFailed(req); break
      case ROUTE.topics: if (get) return json({ square: SQUARE_TOPIC || null, topics: square.topicDirectory() }); break
      case ROUTE.topicCreate: if (post) return handleTopicCreate(req); break
      case ROUTE.topicArchive: if (post) return json({ results: ports.archive.archive(parseTopicList(await req.json())) }); break
      case ROUTE.topicRestore: if (post) return json({ results: ports.archive.restore(parseTopicList(await req.json())) }); break
      case ROUTE.topicRename: if (post) {
        const { topic, name } = parseTopicRename(await req.json())
        return json({ results: [await ports.archive.rename(topic, name)] })
      } break
      case ROUTE.topicKickoff: if (post) {
        const { topic, prompt } = parseTopicKickoff(await req.json())
        return json({ results: [ports.kickoff(topic, prompt)] })
      } break
      case ROUTE.topicReparent: if (post) {
        const { topic, parent } = parseTopicReparent(await req.json())
        return json({ results: [ports.archive.reparent(topic, parent)] })
      } break
      case ROUTE.topicRelaunch: if (post) {
        if (!ports.topicControl) return json({ error: 'relaunch needs the conductor ledger' }, 503)
        return json({ results: await ports.topicControl.relaunch(parseTopicList(await req.json())) })
      } break
      case ROUTE.routeCatalog: if (get) {
        if (!ports.topicControl) return json({ error: 'the route catalog needs the conductor' }, 503)
        return json(ports.topicControl.routes())
      } break
      case ROUTE.topicRoute: if (post) {
        if (!ports.topicControl) return json({ error: 'route changes need the conductor' }, 503)
        const { topic, choice } = parseTopicRoute(await req.json())
        const result = await ports.topicControl.route(topic, choice)
        if ('ok' in result) return json(result.ok)
        const { status, code, message } = result.refused
        return json({ error: { code, message } }, status)
      } break
      case ROUTE.squareTag: if (post) return square.handleSquareTag(req); break
      case ROUTE.squareReply: if (post) return square.handleSquareReply(req); break
      case ROUTE.remind: if (post) return reminders.handleRemind(req); break
      case ROUTE.reminders: if (get) return reminders.handleListReminders(url); break
      case ROUTE.reminderCancel: if (post) return reminders.handleCancelReminder(req); break
      case ROUTE.send: if (post) return outbound.handleSend(req); break
      case ROUTE.react: if (post) return outbound.handleReact(req); break
      case ROUTE.edit: if (post) return outbound.handleEdit(req); break
      case ROUTE.deleteMessage: if (post) return outbound.handleDelete(req); break
      case ROUTE.download: if (post) return outbound.handleDownload(req); break
      case ROUTE.permissionRequest: if (post) return handlePermissionRequest(req); break
    }
    return new Response('not found', { status: 404 })
  }

  // Binds the loopback port, retrying while a replaced proxy releases it.
  async function serve(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        Bun.serve({
          port: PORT,
          hostname: '127.0.0.1', // loopback only; the MCP clients are local
          idleTimeout: 60, // > the long-poll hold
          async fetch(req) {
            try {
              return await route(req)
            } catch (e) {
              const m = e instanceof Error ? e.message : String(e)
              return json({ error: m }, e instanceof BadRequest || e instanceof SyntaxError ? 400 : 500)
            }
          },
        })
        log(`http server listening on ${PROXY_URL}`)
        return
      } catch (e) {
        if (attempt >= 10) {
          // The port never freed (a foreign process, not a stale proxy). Exit so
          // launchd restarts the proxy later, rather than linger without a server.
          log(`port ${PORT} still busy after ${attempt} attempts, exiting for a clean restart: ${e}`)
          process.exit(1)
        }
        log(`port ${PORT} busy (attempt ${attempt}, stale proxy draining?), retrying in 500ms: ${e}`)
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }

  return { serve }
}
