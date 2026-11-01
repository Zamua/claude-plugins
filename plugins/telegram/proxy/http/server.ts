// The loopback HTTP API the topic MCPs and hooks call: inbound long-polls, the
// permission relay, the topic directory, and the routes each context answers.
import { InlineKeyboard } from 'grammy'
import type { Api } from 'grammy'
import { GROUP_CHAT_ID, PORT, PROXY_URL, SQUARE_TOPIC } from '../config'
import type { LockedHarness } from '../harness/domain/topic-harness'
import type { TopicHarnessAdapter } from '../harness/topic-harness-adapter'
import { log } from '../log'
import type { createReminders } from '../reminders/reminders'
import type { RouteChangeReason, TopicRoute } from '../routing/domain/model-routing'
import type { createRouting } from '../routing/routing'
import { inboundModeForRoute } from '../shared/domain/inbound-delivery'
import { topicSlug } from '../shared/domain/topic-slug'
import type { createSquare } from '../square/square'
import { encodeCallback } from '../telegram/telegram-callback'
import { threadIdForTopic } from '../telegram/telegram-messages'
import { resumeNoticeTurn } from '../topics/lifecycle'
import { pendingPerms, prunePendingPerms } from '../topics/permissions'
import { saveRegistry } from '../topics/registry'
import { currentRoute, getTopic, topicNames, topics } from '../topics/state'
import type { createOutbound } from './outbound'
import { BadRequest, parsePermissionRequest, parseTopicCreate } from './requests'
import { json } from './response'
import { ROUTE } from './routes'

const LONG_POLL_MS = 25_000

export type HttpPorts = {
  api: Api
  outbound: ReturnType<typeof createOutbound>
  harnessOfKind: (kind: LockedHarness) => TopicHarnessAdapter
  schedulePanePump: (topic: string, delayMs?: number) => void
  applyRouteNow: (topic: string, route: TopicRoute, reason: RouteChangeReason) => void
  routing: Pick<ReturnType<typeof createRouting>, 'handleRateLimit' | 'handleCapacity' | 'handleTurnFailed'>
  square: Pick<
    ReturnType<typeof createSquare>,
    'topicDirectory' | 'slugForTopic' | 'handleSquareTag' | 'handleSquareReply'
  >
  reminders: Pick<ReturnType<typeof createReminders>, 'handleRemind' | 'handleListReminders' | 'handleCancelReminder'>
  /** When Telegram polling last started, or null while it is down. */
  pollingSince: () => number | null
}

// Answers with the next queued item, or holds the request until one is handed
// to its waiter, answering 204 after the hold.
function longPoll<T>(queue: T[], waiters: Array<(item: T | null) => void>): Promise<Response> {
  const existing = queue.shift()
  if (existing) return Promise.resolve(json(existing))
  return new Promise<Response>(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const wrapped = (item: T | null) => {
      clearTimeout(timer)
      resolve(item ? json(item) : new Response(null, { status: 204 }))
    }
    timer = setTimeout(() => {
      const i = waiters.indexOf(wrapped)
      if (i >= 0) waiters.splice(i, 1)
      resolve(new Response(null, { status: 204 }))
    }, LONG_POLL_MS)
    waiters.push(wrapped)
  })
}

export function createHttpServer(ports: HttpPorts) {
  const { api, outbound, harnessOfKind, schedulePanePump, applyRouteNow, routing, square, reminders } = ports

  function handlePoll(url: URL): Promise<Response> {
    const topic = url.searchParams.get('topic') ?? 'general'
    const st = getTopic(topic)
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
    if (st.pendingRoute) {
      const pending = st.pendingRoute
      applyRouteNow(topic, pending.route, pending.reason)
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    if (st.pendingResumeNotice) {
      const content = st.pendingResumeNotice
      st.pendingResumeNotice = undefined
      saveRegistry()
      return Promise.resolve(json(resumeNoticeTurn(topic, content)))
    }
    return longPoll(st.queue, st.waiters)
  }

  // A topic-MCP forwards a harness permission prompt here. Remember it against
  // the origin topic and post an approve/deny prompt into that topic's thread.
  async function handlePermissionRequest(req: Request): Promise<Response> {
    const { topic, requestId, tool, input } = parsePermissionRequest(await req.json())

    prunePendingPerms()
    pendingPerms.set(requestId, { topic, createdAt: Date.now() })

    const threadId = threadIdForTopic(topic)
    const trimmed = input.length > 500 ? input.slice(0, 500) + '…' : input
    const preview = trimmed ? `\n\n${trimmed}` : ''
    const text =
      `🔐 Permission: ${tool}${preview}\n\n` +
      `Tap a button, or reply "yes ${requestId}" to allow / "no ${requestId}" to deny.`
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', encodeCallback({ kind: 'permission', behavior: 'allow', requestId }))
      .text('❌ Deny', encodeCallback({ kind: 'permission', behavior: 'deny', requestId }))
    await api.sendMessage(String(GROUP_CHAT_ID), text, {
      ...(threadId != null ? { message_thread_id: threadId } : {}),
      reply_markup: keyboard,
    })
    return json({ ok: true })
  }

  function handlePermissionPoll(url: URL): Promise<Response> {
    const st = getTopic(url.searchParams.get('topic') ?? 'general')
    return longPoll(st.permQueue, st.permWaiters)
  }

  // Telegram never echoes a bot's own actions via getUpdates, so a topic the bot
  // creates is invisible until a human messages it. Created here, the response
  // carries its thread id and it is registered at once. Needs the bot to be a
  // group admin with can_manage_topics.
  async function handleTopicCreate(req: Request): Promise<Response> {
    const { name, harness } = parseTopicCreate(await req.json())
    const lockNewTopic = harness === 'claude' ? undefined : await harnessOfKind(harness).prepareTopic(name)
    const created = await api.createForumTopic(String(GROUP_CHAT_ID), name)
    const topic = String(created.message_thread_id)
    const st = getTopic(topic)
    st.name = name
    topicNames.set(topic, name)
    saveRegistry()
    if (lockNewTopic) await lockNewTopic(topic)
    log(`created + registered topic ${topic} "${name}"`)
    return json({
      topic,
      thread_id: created.message_thread_id,
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
      case ROUTE.poll: if (get) return handlePoll(url); break
      case ROUTE.permissionPoll: if (get) return handlePermissionPoll(url); break
      case ROUTE.health: if (get) return handleHealth(); break
      case ROUTE.rateLimit: if (post) return routing.handleRateLimit(req); break
      case ROUTE.capacity: if (post) return routing.handleCapacity(req); break
      case ROUTE.turnFailed: if (post) return routing.handleTurnFailed(req); break
      case ROUTE.topics: if (get) return json({ square: SQUARE_TOPIC || null, topics: square.topicDirectory() }); break
      case ROUTE.topicCreate: if (post) return handleTopicCreate(req); break
      case ROUTE.squareTag: if (post) return square.handleSquareTag(req); break
      case ROUTE.squareReply: if (post) return square.handleSquareReply(req); break
      case ROUTE.remind: if (post) return reminders.handleRemind(req); break
      case ROUTE.reminders: if (get) return reminders.handleListReminders(url); break
      case ROUTE.reminderCancel: if (post) return reminders.handleCancelReminder(req); break
      case ROUTE.send: if (post) return outbound.handleSend(req); break
      case ROUTE.react: if (post) return outbound.handleReact(req); break
      case ROUTE.edit: if (post) return outbound.handleEdit(req); break
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
