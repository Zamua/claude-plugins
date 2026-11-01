// A Claude topic's agent: spawning it, queueing its inbound turns, typing them
// into its pane on a proxied route, stopping it, and /relaunch.
import { readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import type { ChatPort } from '../chat/domain/chat-port'
import {
  CAPACITY_HOOK,
  
  EFFECTIVE_SETTINGS_DIR,
  FAILOVER_HOOK,
  GROUP_CHAT_ID,
  HC_SESSION,
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
import type { TopicRoute } from '../routing/domain/model-routing'
import type { ProviderCatalog } from '../routing/provider-catalog'
import { inboundModeForRoute, renderPaneTurn } from '../shared/domain/inbound-delivery'
import { writeJsonAtomic } from '../shared/json-file'
import { RELAUNCH_META } from '../shared/domain/turn-meta'
import { claudeSpawnEnv } from './claude-launch'
import type { ClaudeSpawnSpec } from './claude-launch'
import { effectiveClaudeSettings } from './claude-settings'
import { claudeConversationExists } from './claude-transcript'
import { missingConversationNotice, planRelaunch, spawnConversation, spawnFailureNotice } from './domain/topic-conversation'
import { nextAgent, sessionOf } from './domain/agent'
import type { AgentEvent } from './domain/agent'
import { nextTurn } from './domain/pane-turn'
import type { PaneTurn } from './domain/pane-turn'
import { muxes } from './mux'
import { saveRegistry } from './registry'
import { currentRoute, getTopic, legacySessionNameFor, sessionNameFor, topicNames, topics } from './state'
import type { InboundMsg, TopicState } from './state'

export type TopicLifecyclePorts = {
  chat: Pick<ChatPort, 'send'>
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  /** True when a harness other than Claude owns the topic. */
  harnessLocked: (topic: string) => boolean
  modelCatalog: () => ProviderCatalog
  /** The running turn ended: a route change waiting for it applies now. */
  turnEnded: (topic: string) => void
  /** The resumed session received its resume notice. */
  noticeDelivered: (topic: string) => void
  /** A topic's Claude was started under herdr-core. */
  hcLaunched?: () => void
}

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

/**
 * What ensureSession did: found the agent running (or booting), started it, could not start it (a failed launch or a
 * conversation missing on disk, both reported in the topic), or had nothing to start (a locked topic, the square).
 */
export type SpawnOutcome = 'running' | 'spawned' | 'failed' | 'skipped'

type PanePumpState = {
  timer?: ReturnType<typeof setTimeout>
  turn: PaneTurn
}

export function createTopicLifecycle({ chat, sayIn, harnessLocked, modelCatalog, turnEnded, noticeDelivered, hcLaunched }: TopicLifecyclePorts) {
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

  // Kills a topic's session AND drops its long-polls. A killed MCP's /poll
  // waiter stays registered until the proxy sees its connection close, and
  // enqueue prefers a waiter to the queue, so a nudge enqueued right after a
  // bare mux.kill would be handed to the dying process and lost.
  function killSession(st: TopicState, topic: string): boolean {
    const session = sessionOf(st.agent)
    const mux = muxes.forTopic(topic)
    const killed = !!session && mux.liveSessions().has(session) && mux.kill(session)
    apply(topic, st, { type: 'stopped' })
    const pump = panePumps.get(topic)
    if (pump) pump.turn = nextTurn(pump.turn, { type: 'stopped' })
    return killed
  }

  function panePumpState(topic: string): PanePumpState {
    let state = panePumps.get(topic)
    if (!state) {
      state = { turn: { state: 'settled' } }
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

  const paneInFlight = (topic: string): boolean => {
    const turn = panePumps.get(topic)?.turn
    return !!turn && turn.state !== 'settled'
  }

  function pendingPaneMessage(topic: string, st: TopicState): { message: InboundMsg; resumeNotice: boolean } | undefined {
    if (st.routing.resumeNotice) {
      return { message: resumeNoticeTurn(topic, st.routing.resumeNotice), resumeNotice: true }
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

    ensureSession(topic, 'timer')
    const state = panePumpState(topic)
    const session = sessionOf(st.agent)
    const runtime = session ? muxes.forTopic(topic).runtime(session) : 'missing'

    state.turn = nextTurn(state.turn, { type: 'sampled', runtime, now: Date.now() })
    if (state.turn.state !== 'settled') {
      schedulePanePump(topic, 250)
      return
    }

    if (st.routing.pending) {
      if (runtime === 'idle' || runtime === 'missing') {
        turnEnded(topic)
      } else {
        schedulePanePump(topic, 500)
      }
      return
    }

    const pending = pendingPaneMessage(topic, st)
    if (!pending) return
    if (runtime !== 'idle' || !session) {
      // The turn stays queued; whatever retries the start pumps it again
      if (runtime === 'missing' && st.agent.state === 'failed') return
      schedulePanePump(topic, 500)
      return
    }

    if (!muxes.forTopic(topic).prompt(session, renderPaneTurn(pending.message))) {
      schedulePanePump(topic, 500)
      return
    }

    if (pending.resumeNotice) {
      noticeDelivered(topic)
    } else {
      st.queue.shift()
    }
    state.turn = nextTurn(state.turn, { type: 'submitted', now: Date.now() })
    log(`delivered Telegram turn to proxied Claude pane ${session} for topic ${topic}`)
    schedulePanePump(topic, 150)
  }

  /** Restarts the pane pump of every proxied topic that boots with work pending. */
  function resumePendingPanes(): void {
    for (const [topic, st] of topics) {
      if (
        inboundModeForRoute(currentRoute(st)) === 'pane' &&
        (st.queue.length > 0 || !!st.routing.resumeNotice || !!st.routing.pending)
      ) {
        schedulePanePump(topic)
      }
    }
  }

  function postSpawnNotice(kind: 'missing-conversation' | 'spawn-failed', topic: string, text: string): void {
    const key = `${kind}:${topic}`
    if (Date.now() - (lastSpawnNotice.get(key) ?? 0) < SPAWN_NOTICE_MS) return
    lastSpawnNotice.set(key, Date.now())
    chat.send(topic, { text })
      .catch(e => log(`${kind} notice failed for topic ${topic}: ${e}`))
  }

  function reportMissingConversation(topic: string, sessionId: string): void {
    log(`topic ${topic}: claude conversation ${sessionId} not found on disk; not spawning`)
    postSpawnNotice('missing-conversation', topic, missingConversationNotice(sessionId))
  }

  // Moves the topic's agent through one event and performs what the step asks for.
  function apply(topic: string, st: TopicState, event: AgentEvent): SpawnOutcome {
    const { agent, effects } = nextAgent(st.agent, event)
    st.agent = agent
    let outcome: SpawnOutcome = agent.state === 'failed' ? 'failed' : 'running'
    for (const effect of effects) {
      switch (effect.type) {
        case 'drain-waiters':
          while (st.waiters.length) st.waiters.shift()?.(null)
          while (st.permWaiters.length) st.permWaiters.shift()?.(null)
          break
        case 'save':
          saveRegistry()
          break
        case 'report-missing-conversation':
          reportMissingConversation(topic, st.claudeSessionId ?? '')
          break
        case 'start':
          outcome = start(topic, st)
          break
        default: {
          const unhandled: never = effect
          throw new Error(`unhandled agent effect ${JSON.stringify(unhandled)}`)
        }
      }
    }
    return outcome
  }

  // Ensures a live Claude session for a topic. Single-flight: spawnSync blocks the event loop for the whole launch,
  // so two messages for a new topic cannot start two sessions. Dedup is on the RECORDED session name.
  function ensureSession(topic: string, by: 'event' | 'timer' = 'event'): SpawnOutcome {
    // A locked topic must never fall through to the Claude launcher.
    if (harnessLocked(topic)) return 'skipped'
    // The square hosts conversations, not a Claude of its own.
    if (SQUARE_TOPIC && topic === SQUARE_TOPIC) return 'skipped'
    const st = getTopic(topic)
    const mux = muxes.forTopic(topic)
    const session = sessionOf(st.agent)
    // A topic moved to another multiplexer stops there and resumes here, never runs
    // twice; its dying MCP's long-polls are dropped, as killSession drops them.
    const moved = session ? muxes.elsewhere(topic, session) : []
    for (const old of moved) {
      log(`moving topic ${topic} from ${old.kind} to ${mux.kind}: stopping ${session} there`)
      if (session) old.kill(session)
    }
    if (moved.length) apply(topic, st, { type: 'stopped' })
    const live = mux.liveSessions()
    const legacy = legacySessionNameFor(topic)
    const outcome = apply(topic, st, {
      type: 'wanted',
      by,
      now: Date.now(),
      live: !!session && live.has(session),
      ...(live.has(legacy) && { legacy }),
    })
    if (!session && sessionOf(st.agent) === legacy) {
      log(`adopted legacy-named session ${legacy} for topic ${topic}; renames on next respawn`)
    }
    return outcome
  }

  function start(topic: string, st: TopicState): SpawnOutcome {
    if (st.claudeSessionId && !claudeConversationExists(st.claudeSessionId)) {
      return apply(topic, st, { type: 'conversation-missing', now: Date.now() })
    }
    try {
      const label = st.name || topicNames.get(topic) || topic
      st.name = label
      // Bound to a new conversation only once its launch succeeds: a failed
      // first launch leaves no transcript to resume.
      const conversation = spawnConversation(st.claudeSessionId, () => crypto.randomUUID())
      const resuming = conversation.resume
      const route = st.routing.route
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
        muxKind: muxes.forTopic(topic).kind,
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
        ...(spec.muxKind === 'hc' && { HC_SESSION }),
      }
      const r = spawnSync('bash', [LAUNCH_SCRIPT], { env, encoding: 'utf8' })
      if (r.status !== 0) {
        throw new Error(`launcher exit ${r.status}: ${(r.stderr || '').trim()}`)
      }
      st.claudeSessionId = conversation.claudeSessionId
      apply(topic, st, { type: 'started', session: name, now: Date.now(), profile: TOPIC_LAUNCH_PROFILE_VERSION })
      if (spec.muxKind === 'hc') hcLaunched?.()
      log(
        `${resuming ? 'resumed' : 'spawned'} topic ${topic} "${label}" ` +
        `(claude ${st.claudeSessionId}; ${route.provider}/${route.model}; ${route.effort}; ` +
        `aux ${auxiliaryModel}; subagents locked; ultracode ${route.ultracode ? 'on' : 'off'}; ` +
        `compact ${autoCompactWindow(route.provider, routeModel?.contextWindow) ?? 'auto'}) ` +
        `-> ${muxes.forTopic(topic).kind} ${name}`,
      )
      return 'spawned'
    } catch (e) {
      log(`spawn failed for topic ${topic}: ${e}`)
      postSpawnNotice('spawn-failed', topic, spawnFailureNotice(reason(e)))
      apply(topic, st, { type: 'start-failed', now: Date.now() })
      return 'failed'
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
        user_id: '',
        ts: new Date().toISOString(),
        ...(topic !== 'general' ? { message_thread_id: topic } : {}),
        ...RELAUNCH_META,
      },
    })
    ensureSession(topic)
  }

  /** Presses the topic's agent's stop key; false when it is not running. */
  function interrupt(topic: string): boolean {
    const agent = topics.get(topic)?.agent
    return agent?.state === 'running' && muxes.forTopic(topic).interrupt(agent.session)
  }

  return {
    enqueue,
    killSession,
    ensureSession,
    schedulePanePump,
    paneInFlight,
    resumePendingPanes,
    relaunch,
    interrupt,
  }
}
