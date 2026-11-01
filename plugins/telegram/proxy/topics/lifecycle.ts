// A Claude topic's agent: spawning it, queueing its inbound turns, typing them
// into its pane on a proxied route, stopping it, and /relaunch.
import { readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import type { Api } from 'grammy'
import {
  CAPACITY_HOOK,
  DEFAULT_TOPIC_ROUTE,
  EFFECTIVE_SETTINGS_DIR,
  FAILOVER_HOOK,
  GROUP_CHAT_ID,
  LAUNCH_SCRIPT,
  MARKETPLACE,
  OVERRIDE_SETTINGS,
  PROVIDER_PROXY_URL,
  PROXY_URL,
  SPAWN_DIR,
  SQUARE_TOPIC,
  STOP_HOOK,
  TOPIC_LAUNCH_PROFILE_VERSION,
} from '../config'
import { log, reason } from '../log'
import { autoCompactWindow, auxiliaryModelForRoute } from '../routing/domain/model-routing'
import type { RouteChangeReason, TopicRoute } from '../routing/domain/model-routing'
import type { ProviderCatalog } from '../routing/provider-catalog'
import { inboundModeForRoute, renderPaneTurn } from '../shared/domain/inbound-delivery'
import { writeJsonAtomic } from '../shared/json-file'
import { RELAUNCH_META } from '../shared/domain/turn-meta'
import { threadOf } from '../telegram/telegram-messages'
import { claudeSpawnEnv } from './claude-launch'
import type { ClaudeSpawnSpec } from './claude-launch'
import { effectiveClaudeSettings } from './claude-settings'
import { claudeConversationExists } from './claude-transcript'
import { missingConversationNotice, planRelaunch, spawnConversation, spawnFailureNotice } from './domain/topic-conversation'
import { mux } from './mux'
import { saveRegistry } from './registry'
import { currentRoute, getTopic, legacySessionNameFor, sessionNameFor, topicNames, topics } from './state'
import type { InboundMsg, TopicState } from './state'

export type TopicLifecyclePorts = {
  api: Api
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  /** True when a harness other than Claude owns the topic. */
  harnessLocked: (topic: string) => boolean
  modelCatalog: () => ProviderCatalog
  applyRouteNow: (topic: string, route: TopicRoute, reason: RouteChangeReason) => void
}

// How long after a spawn the topic counts as live although the multiplexer
// sees no agent yet: herdr reports a new pane `unknown` for its first ~2s.
const SPAWN_GRACE_MS = 30_000
// Every message to a topic that cannot start retries ensureSession, so its
// failure notice is posted at most once a minute per topic and kind.
const SPAWN_NOTICE_MS = 60_000
// A second /relaunch inside the spawn window cannot double-spawn, but it would
// enqueue a second nudge and the fresh session would answer twice.
const RELAUNCH_DEBOUNCE_MS = 30_000

/** The notice telling a resumed session to answer the last unanswered message. */
export function resumeNoticeTurn(topic: string, content: string): InboundMsg {
  return {
    content,
    meta: {
      chat_id: String(GROUP_CHAT_ID),
      user: 'telegram-topics-proxy',
      ts: new Date().toISOString(),
      ...(topic !== 'general' ? { message_thread_id: topic } : {}),
      route_switch: '1',
    },
  }
}

// Generated per spawn so each one reflects the committed override-settings.json
// as it is now. Falls back to that base file, without the route's Ultracode
// value, when it cannot be generated.
function resolveSettings(topic: string, route: TopicRoute): string {
  try {
    const base = JSON.parse(readFileSync(OVERRIDE_SETTINGS, 'utf8'))
    const settings = effectiveClaudeSettings(base, route)
    const safeTopic = topic.replace(/[^a-zA-Z0-9_-]/g, '_')
    const settingsPath = join(EFFECTIVE_SETTINGS_DIR, `${safeTopic}.json`)
    // The model is not baked in: a resumed session ignores a settings `model`,
    // so the launcher passes it as the --model flag instead.
    writeJsonAtomic(settingsPath, settings)
    return settingsPath
  } catch (e) {
    log(`could not generate effective settings (${e}); using override-settings.json`)
    return OVERRIDE_SETTINGS
  }
}

type PanePumpState = {
  timer?: ReturnType<typeof setTimeout>
  inFlight: boolean
  observedActive: boolean
  submittedAt: number
}

export function createTopicLifecycle({ api, sayIn, harnessLocked, modelCatalog, applyRouteNow }: TopicLifecyclePorts) {
  const panePumps = new Map<string, PanePumpState>()
  const lastSpawnNotice = new Map<string, number>()
  const lastRelaunch = new Map<string, number>()

  function enqueue(topic: string, msg: InboundMsg): void {
    const st = getTopic(topic)
    if (inboundModeForRoute(currentRoute(st)) === 'pane') {
      // A proxied Claude runs under API billing, where Claude Code disables
      // Channels, so a stale /poll waiter would discard the message. The pane
      // pump delivers it instead.
      while (st.waiters.length) st.waiters.shift()?.(null)
      st.queue.push(msg)
      log(
        `queued Telegram turn ${msg.meta.message_id ?? '(no id)'} for proxied Claude topic ${topic} ` +
        `(proxy depth ${st.queue.length})`,
      )
      schedulePanePump(topic)
      return
    }
    const waiter = st.waiters.shift()
    if (waiter) waiter(msg)
    else st.queue.push(msg)
  }

  // Kills a topic's session AND drops its long-polls. A dead MCP's /poll waiter
  // stays registered until it times out, and enqueue prefers a waiter to the
  // queue, so a nudge enqueued after a bare mux.kill would be handed to the
  // dead process and lost. Resolving the waiters answers 204 to dead sockets.
  function killSession(st: TopicState, topic: string): boolean {
    const killed = !!(st.session && mux.liveSessions().has(st.session)) && mux.kill(st.session)
    while (st.waiters.length) st.waiters.shift()?.(null)
    while (st.permWaiters.length) st.permWaiters.shift()?.(null)
    st.session = ''
    st.spawnedAt = 0
    st.launchProfileVersion = undefined
    return killed
  }

  function panePumpState(topic: string): PanePumpState {
    let state = panePumps.get(topic)
    if (!state) {
      state = { inFlight: false, observedActive: false, submittedAt: 0 }
      panePumps.set(topic, state)
    }
    return state
  }

  function schedulePanePump(topic: string, delayMs = 0): void {
    const st = getTopic(topic)
    if (inboundModeForRoute(currentRoute(st)) !== 'pane') return
    const state = panePumpState(topic)
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      pumpPane(topic)
    }, delayMs)
  }

  const paneInFlight = (topic: string): boolean => !!panePumps.get(topic)?.inFlight

  function pendingPaneMessage(topic: string, st: TopicState): { message: InboundMsg; resumeNotice: boolean } | undefined {
    if (st.pendingResumeNotice) {
      return { message: resumeNoticeTurn(topic, st.pendingResumeNotice), resumeNotice: true }
    }
    const message = st.queue[0]
    return message ? { message, resumeNotice: false } : undefined
  }

  /**
   * Deliver queued turns to a proxied Claude through its foreground prompt,
   * one at a time: submit only while the pane is idle, then wait for that turn
   * to become active and settle before the next. The conversation is untouched.
   */
  function pumpPane(topic: string): void {
    const st = getTopic(topic)
    if (inboundModeForRoute(currentRoute(st)) !== 'pane') return

    ensureSession(topic)
    const state = panePumpState(topic)
    const runtime = st.session ? mux.runtime(st.session) : 'missing'

    if (state.inFlight) {
      if (runtime === 'busy' || runtime === 'blocked' || runtime === 'starting') {
        state.observedActive = true
      }
      // A very short turn can finish between samples; five seconds after an
      // accepted prompt, an idle pane is done even if its busy edge was missed.
      if (runtime === 'idle' && (state.observedActive || Date.now() - state.submittedAt >= 5000)) {
        state.inFlight = false
        state.observedActive = false
      } else {
        schedulePanePump(topic, 250)
        return
      }
    }

    if (st.pendingRoute) {
      if (runtime === 'idle' || runtime === 'missing') {
        const pending = st.pendingRoute
        applyRouteNow(topic, pending.route, pending.reason)
      } else {
        schedulePanePump(topic, 500)
      }
      return
    }

    const pending = pendingPaneMessage(topic, st)
    if (!pending) return
    if (runtime !== 'idle' || !st.session) {
      schedulePanePump(topic, 500)
      return
    }

    if (!mux.prompt(st.session, renderPaneTurn(pending.message))) {
      schedulePanePump(topic, 500)
      return
    }

    if (pending.resumeNotice) {
      st.pendingResumeNotice = undefined
      saveRegistry()
    } else {
      st.queue.shift()
    }
    state.inFlight = true
    state.observedActive = false
    state.submittedAt = Date.now()
    log(`delivered Telegram turn to proxied Claude pane ${st.session} for topic ${topic}`)
    schedulePanePump(topic, 150)
  }

  /** Restarts the pane pump of every proxied topic that boots with work pending. */
  function resumePendingPanes(): void {
    for (const [topic, st] of topics) {
      if (
        inboundModeForRoute(currentRoute(st)) === 'pane' &&
        (st.queue.length > 0 || !!st.pendingResumeNotice || !!st.pendingRoute)
      ) {
        schedulePanePump(topic)
      }
    }
  }

  function postSpawnNotice(kind: 'missing-conversation' | 'spawn-failed', topic: string, text: string): void {
    const key = `${kind}:${topic}`
    if (Date.now() - (lastSpawnNotice.get(key) ?? 0) < SPAWN_NOTICE_MS) return
    lastSpawnNotice.set(key, Date.now())
    api.sendMessage(String(GROUP_CHAT_ID), text, threadOf(topic))
      .catch(e => log(`${kind} notice failed for topic ${topic}: ${e}`))
  }

  function reportMissingConversation(topic: string, sessionId: string): void {
    log(`topic ${topic}: claude conversation ${sessionId} not found on disk; not spawning`)
    postSpawnNotice('missing-conversation', topic, missingConversationNotice(sessionId))
  }

  // Ensures a live Claude session for a topic. Single-flight: spawnSync blocks
  // the event loop for the whole launch, so two messages for a new topic cannot
  // spawn two sessions; the spawning flag and the live-session dedup back it up.
  function ensureSession(topic: string): void {
    // A locked topic must never fall through to the Claude launcher.
    if (harnessLocked(topic)) return
    // The square hosts conversations, not a Claude of its own.
    if (SQUARE_TOPIC && topic === SQUARE_TOPIC) return
    const st = getTopic(topic)
    if (st.spawning) return
    const live = mux.liveSessions()
    // Dedup on the RECORDED session name, never a re-derived one: the name
    // follows the topic's label, so re-deriving after a rename would miss the
    // running session and spawn a second. Anything spawned inside the grace
    // window counts as live, so a message during boot cannot spawn a second.
    const bootingGrace =
      !!st.session && st.spawnedAt > 0 && Date.now() - st.spawnedAt < SPAWN_GRACE_MS
    if (st.session && (live.has(st.session) || bootingGrace)) {
      if (!st.spawnedAt) {
        st.spawnedAt = Date.now()
        saveRegistry()
      }
      return
    }
    // A live, untracked session under the old `tg-<cid>-<tid>` name is adopted
    // rather than doubled: the launcher's guard checks only the new name. It
    // takes the new name on its next respawn.
    if (!st.session) {
      const legacy = legacySessionNameFor(topic)
      if (live.has(legacy)) {
        st.session = legacy
        if (!st.spawnedAt) st.spawnedAt = Date.now()
        saveRegistry()
        log(`adopted legacy-named session ${legacy} for topic ${topic}; renames on next respawn`)
        return
      }
    }
    // A topic bound to a conversation must resume THAT conversation. If its file
    // is gone, starting a fresh one would silently drop the topic's history;
    // /relaunch is the explicit way out.
    if (st.claudeSessionId && !claudeConversationExists(st.claudeSessionId)) {
      reportMissingConversation(topic, st.claudeSessionId)
      return
    }
    st.spawning = true
    try {
      const label = st.name || topicNames.get(topic) || topic
      st.name = label
      // Bound to a new conversation only once its launch succeeds: a failed
      // first launch leaves no transcript to resume.
      const conversation = spawnConversation(st.claudeSessionId, () => crypto.randomUUID())
      const resuming = conversation.resume
      const route = st.route ?? DEFAULT_TOPIC_ROUTE
      st.route = route
      const name = sessionNameFor(topic, label)
      const settingsPath = resolveSettings(topic, route)
      const providerModels = modelCatalog()[route.provider]
      const routeModel = providerModels.find(model => model.id === route.model)
      const auxiliaryModel = auxiliaryModelForRoute(
        route,
        providerModels.filter(model => model.bridgeSupported !== false).map(model => model.id),
      )
      const spec: ClaudeSpawnSpec = {
        topic,
        label,
        sessionName: name,
        muxKind: mux.kind,
        spawnDir: SPAWN_DIR,
        proxyUrl: PROXY_URL,
        squareTopic: SQUARE_TOPIC,
        marketplace: MARKETPLACE,
        route,
        auxiliaryModel,
        claudeSessionId: conversation.claudeSessionId,
        resume: resuming,
        settingsPath,
        stopHook: STOP_HOOK,
        failoverHook: FAILOVER_HOOK,
        capacityHook: CAPACITY_HOOK,
        providerProxyUrl: PROVIDER_PROXY_URL,
        modelContextWindow: routeModel?.contextWindow,
      }
      const env = {
        ...process.env,
        ...claudeSpawnEnv(spec),
      }
      const r = spawnSync('bash', [LAUNCH_SCRIPT], { env, encoding: 'utf8' })
      if (r.status !== 0) {
        throw new Error(`launcher exit ${r.status}: ${(r.stderr || '').trim()}`)
      }
      st.claudeSessionId = conversation.claudeSessionId
      st.session = name
      st.spawnedAt = Date.now()
      st.launchProfileVersion = TOPIC_LAUNCH_PROFILE_VERSION
      saveRegistry()
      log(
        `${resuming ? 'resumed' : 'spawned'} topic ${topic} "${label}" ` +
        `(claude ${st.claudeSessionId}; ${route.provider}/${route.model}; ${route.effort}; ` +
        `aux ${auxiliaryModel}; subagents locked; ultracode ${route.ultracode ? 'on' : 'off'}; ` +
        `compact ${autoCompactWindow(route.provider, routeModel?.contextWindow) ?? 'auto'}) ` +
        `-> ${mux.kind} ${name}`,
      )
    } catch (e) {
      log(`spawn failed for topic ${topic}: ${e}`)
      postSpawnNotice('spawn-failed', topic, spawnFailureNotice(reason(e)))
    } finally {
      st.spawning = false
    }
  }

  // /relaunch for a Claude topic: kill, ack, enqueue a nudge, respawn with the
  // same conversation. The nudge asks for one line back, so a respawn that
  // fails is a visible silence.
  async function relaunch(chatId: string, topic: string, fromId: string): Promise<void> {
    if (SQUARE_TOPIC && topic === SQUARE_TOPIC) {
      await sayIn(chatId, topic, '♻️ the square has no agent of its own; run /relaunch in a topic.')
      return
    }
    const since = Date.now() - (lastRelaunch.get(topic) ?? 0)
    if (since < RELAUNCH_DEBOUNCE_MS) {
      await sayIn(chatId, topic, `♻️ already relaunching; it answers within a few seconds.`)
      return
    }
    lastRelaunch.set(topic, Date.now())
    const st = getTopic(topic)
    const wasLive = killSession(st, topic)
    const plan = planRelaunch(st.claudeSessionId, id => claudeConversationExists(id), wasLive)
    if (plan.claudeSessionId !== st.claudeSessionId) {
      st.claudeSessionId = plan.claudeSessionId
      saveRegistry()
    }
    log(
      `relaunch of topic ${topic} "${st.name || topic}" requested by user ${fromId} (was ${wasLive ? 'live' : 'not running'})` +
        (plan.missingSessionId ? `; conversation ${plan.missingSessionId} missing on disk, starting a new one` : ''),
    )
    await sayIn(chatId, topic, plan.ack)
    enqueue(topic, {
      content: plan.notice,
      meta: {
        chat_id: chatId,
        user: 'telegram-topics-proxy',
        user_id: fromId,
        ts: new Date().toISOString(),
        ...(topic !== 'general' ? { message_thread_id: topic } : {}),
        ...RELAUNCH_META,
      },
    })
    ensureSession(topic)
  }

  return {
    enqueue,
    killSession,
    ensureSession,
    schedulePanePump,
    paneInFlight,
    resumePendingPanes,
    relaunch,
  }
}
