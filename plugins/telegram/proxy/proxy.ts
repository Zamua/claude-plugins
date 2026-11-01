#!/usr/bin/env bun
/**
 * telegram-topics proxy.
 *
 * ONE bot token, ONE getUpdates poll, fanned out to MANY per-topic Claude
 * sessions. This is the only getUpdates consumer of the token (the whole
 * point): it demultiplexes inbound Telegram messages by forum topic
 * (message_thread_id) and routes each to a dedicated, detached tmux Claude
 * session. Channel injection only works foreground, so every topic gets its
 * OWN foreground Claude in its own tmux session; a single --bg agent silently
 * drops channel notifications.
 *
 *   INBOUND  grammy long-poll -> group-chat gate -> topic = message_thread_id
 *            (or "general") -> enqueue {content, meta}; spawn the topic's tmux
 *            Claude if none is live (single-flight). The MCP client inside that
 *            session drains the queue via GET /poll.
 *   OUTBOUND the four MCP tools POST here (/send /react /edit /download); each
 *            call carries its topic and is executed against the one grammy bot
 *            with message_thread_id set to the topic (omitted for "general").
 *
 * Config (env; see .env.example):
 *   TELEGRAM_BOT_TOKEN          the one bot token
 *   TELEGRAM_GROUP_CHAT_ID      the forum supergroup id; updates from any other
 *                               chat are dropped (this is the access control)
 *   TELEGRAM_TOPICS_SPAWN_DIR   cwd for every spawned topic-Claude (default $HOME)
 *   TELEGRAM_PROXY_PORT         HTTP port for the MCP clients (default 8790)
 *   TELEGRAM_TOPICS_MARKETPLACE channel ref for the launcher (default
 *                               plugin:telegram@zamua)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'
import { spawnSync, execFileSync } from 'child_process'
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import {
  SECRET_CMD_RE, SecretExists, SecretMissing, advanceSecretFlow, beginSecretFlow, deleteSecret, listSecrets,
  parseSecretCommand, secretExists, storeSecret,
} from './secret'
import type { FlowResult, Pending } from './secret'
import { permissionNotice } from './adapters/permission-notice'
import { claudeSpawnEnv } from './adapters/claude-launch'
import type { ClaudeSpawnSpec } from './adapters/claude-launch'
import { effectiveClaudeSettings } from './adapters/claude-settings'
import { catalogFromBridge, parseOpenCodeModels } from './adapters/provider-catalog'
import type { ProviderCatalog, ProviderModel } from './adapters/provider-catalog'
import { readCodexSnapshot } from './adapters/codex-app-server'
import { readOpenCodeGoCapacity } from './adapters/opencode-go-capacity'
import { claudeConversationExists } from './adapters/claude-transcript'
import { installedClaudeVersion, liveClaudeSessions } from './adapters/claude-sessions'
import { updateRestartAction } from './domain/claude-update'
import { callbackHarness, callbackTopic, decodeCallback, encodeCallback, legacySwitchBack } from './adapters/telegram-callback'
import { inboundModeForRoute, renderPaneTurn } from './domain/inbound-delivery'
import {
  auxiliaryModelForRoute,
  autoCompactWindow,
  exhaustedRouteFor,
  forgetExhaustedProvider,
  modelLabel,
  planRouteChange,
  providerLabel,
  quotaFallbackRoute,
  quotaReturnRoute,
  rememberExhaustedRoute,
  retainsExhaustedRoute,
  sameRoute,
  topicRoute,
} from './domain/model-routing'
import type {
  Effort,
  PickerReason,
  ProviderId,
  RouteChangeReason,
  TopicRoute,
} from './domain/model-routing'
import { capacityTransition, nextResetAt, providerCapacity } from './domain/provider-capacity'
import type { ProviderCapacity } from './domain/provider-capacity'
import { environmentFlag } from './domain/env-flag'
import { missingConversationNotice, planRelaunch, spawnConversation, spawnFailureNotice } from './domain/topic-conversation'
import { AntigravityTopicService } from './application/antigravity-topic-service'
import { routeLabel as antigravityRouteLabel } from './adapters/antigravity-cli'
import { HerdrAntigravityRuntime } from './adapters/herdr-antigravity-runtime'
import { syncAntigravityTelegramMcp } from './adapters/antigravity-mcp-config'
import { ANTIGRAVITY_DISABLED_MESSAGE, DisabledAntigravityRuntime } from './adapters/disabled-antigravity-runtime'
import { JsonTopicRepository } from './adapters/json-topic-repository'
import { writeJsonAtomic } from './adapters/json-file'
import {
  claudePluginSkillRoots,
  syncAntigravitySkills,
} from './adapters/antigravity-skill-interop'
import {
  antigravityRoute,
  antigravityTopic,
  antigravityTopicFromRecord,
} from './domain/antigravity-topic'
import type {
  AntigravityModel,
  AntigravityTopic,
} from './domain/antigravity-topic'
import { OpencodeTopicService } from './application/opencode-topic-service'
import { HerdrOpencodeRuntime } from './adapters/herdr-opencode-runtime'
import { opencodeTopic, opencodeTopicFromRecord } from './domain/opencode-topic'
import type { OpencodeTopic } from './domain/opencode-topic'
import { lockRefusal } from './domain/topic-harness'
import { RELAUNCH_META, reminderMeta, SECRET_DROP_META } from './domain/turn-meta'
import { ROUTE } from './http/routes'
import {
  BadRequest,
  parseCancelReminder,
  parseDownload,
  parseEdit,
  parsePermissionRequest,
  parseRateLimit,
  parseReact,
  parseSend,
  parseTopicCreate,
  parseTurnFailed,
} from './http/requests'
import { topicSlug } from './domain/topic-slug'
import type { LockedHarness, TopicHarness } from './domain/topic-harness'
import { LocalgenTopicService } from './application/localgen-topic-service'
import { QwenImageClient } from './adapters/qwen-image-client'
import { localgenTopic, localgenTopicFromRecord } from './domain/localgen-topic'
import type { LocalgenTopic } from './domain/localgen-topic'
import { antigravityResetPools } from './domain/antigravity-capacity'
import type { AntigravityUsageWindow } from './application/antigravity-ports'
import { InvalidReminder, LATE_AFTER_MS, dueReminders, reminderNotice, scheduleReminder } from './domain/reminder'
import type { ReminderRequest } from './domain/reminder'
import { JsonReminderRepository } from './adapters/json-reminder-repository'
import {
  ADMIN_USER_ID,
  ANTIGRAVITY_BIN,
  ANTIGRAVITY_ENABLED,
  ANTIGRAVITY_TOPICS_FILE,
  BOT_API_ROOT,
  CAPACITY_HOOK,
  CAPACITY_POLL_MS,
  DEFAULT_TOPIC_ROUTE,
  EFFECTIVE_SETTINGS_DIR,
  ENV_FILES,
  FAILOVER_HOOK,
  GROUP_CHAT_ID,
  HERDR_LAUNCH_SCRIPT,
  INBOX_DIR,
  LAUNCH_SCRIPT,
  LOCALGEN_START_CMD,
  LOCALGEN_TOPICS_FILE,
  LOCALGEN_URL,
  MARKETPLACE,
  MODEL,
  OPENCODE_BIN,
  OPENCODE_GO_KEY_FILE,
  OPENCODE_MODEL,
  OPENCODE_PROJECT_DIR,
  OPENCODE_TOPICS_FILE,
  OVERRIDE_SETTINGS,
  PID_FILE,
  PLUGIN_ROOT,
  PORT,
  PROVIDER_PROXY_BIN,
  PROVIDER_PROXY_URL,
  PROXY_URL,
  REMINDERS_FILE,
  SECRETS_DIR,
  SECRETS_USER_ID,
  SPAWN_DIR,
  SQUARE_TOPIC,
  STATE_DIR,
  STOP_HOOK,
  TOKEN,
  TOPIC_LAUNCH_PROFILE_VERSION,
  VOICE,
} from './config'
import { log } from './log'
import { mux } from './topics/mux'
import { PERMISSION_REPLY_RE, pendingPerms, prunePendingPerms, resolvePermission } from './topics/permissions'
import { loadAndReconcileRegistry, saveRegistry } from './topics/registry'
import { getTopic, legacySessionNameFor, sessionNameFor, topicNames, topics } from './topics/state'
import type { InboundMsg, PermAnswer, TopicState } from './topics/state'
import { loadConvs } from './square/conversations'
import { createSquare } from './square/square'
import { json } from './http/response'
import {
  assertSendable,
  chunk,
  threadIdForTopic,
  describeMessage,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_LIMIT,
  PHOTO_EXTS,
} from './adapters/telegram-messages'
import { telegramDownloader } from './adapters/telegram-files'
import { transcribeVoice, VOICE_TAG } from './adapters/voice-transcription'

// "/relaunch" in a topic kills that topic's agent and respawns it with the
// same provider route and conversation, freshly loading MCP servers and settings
// that a running session cannot pick up mid-flight.
const RELAUNCH_RE = /^\/relaunch(?:@\w+)?\s*$/
// A double tap lands inside the spawn window: the second request finds no
// live session, so it cannot double-spawn, but it would enqueue a second
// nudge and the fresh session would answer twice.
const RELAUNCH_DEBOUNCE_MS = 30_000
const lastRelaunch = new Map<string, number>()

const MODEL_RE = /^\/model(?:@\w+)?(?:\s+(\S+))?\s*$/
const USAGE_RE = /^\/usage(?:@\w+)?\s*$/
const ANTIGRAVITY_RE = /^\/antigravity(?:@\w+)?\s*$/
const ROUTE_DEBOUNCE_MS = 10_000
const lastRouteChange = new Map<string, number>()
const LOCALCODE_RE = /^\/localcode(?:@\w+)?\s*$/
// /localgen [name]: lock the current fresh topic to the image generator.
const LOCALGEN_RE = /^\/localgen(?:@\w+)?(?:\s+(.+?))?\s*$/

// Called PER SPAWN (not once at module load) so each (re)spawn reflects the
// CURRENT committed override-settings.json - a base-settings edit (e.g. a git
// pull) then reaches topics on their next respawn (an update restart, a kill),
// matching the pre-generation behavior where spawns read the base file live. Also
// self-heals if the generated file is removed. On any read/write error it falls
// back to the committed base un-generated (topics still spawn, just without the
// ultracode override).
function resolveSettings(topic: string, route: TopicRoute): string {
  try {
    const base = JSON.parse(readFileSync(OVERRIDE_SETTINGS, 'utf8'))
    const settings = effectiveClaudeSettings(base, route)
    const safeTopic = topic.replace(/[^a-zA-Z0-9_-]/g, '_')
    const settingsPath = join(EFFECTIVE_SETTINGS_DIR, `${safeTopic}.json`)
    // NB the MODEL is NOT baked in here: a settings `model` is only a default and
    // is ignored by a --resume'd interactive session. The launcher passes MODEL as
    // the --model FLAG (via TG_MODEL) instead, which overrides even on resume.
    writeJsonAtomic(settingsPath, settings)
    return settingsPath
  } catch (e) {
    log(`could not generate effective settings (${e}); using override-settings.json`)
    return OVERRIDE_SETTINGS
  }
}

if (!TOKEN) {
  process.stderr.write(
    'telegram-topics proxy: TELEGRAM_BOT_TOKEN required\n' +
      `  set it in the real env, ${join(PLUGIN_ROOT, '.env')}, or ${join(STATE_DIR, '.env')}\n`,
  )
  process.exit(1)
}
if (!GROUP_CHAT_ID) {
  process.stderr.write(
    'telegram-topics proxy: TELEGRAM_GROUP_CHAT_ID required (the forum supergroup id)\n',
  )
  process.exit(1)
}

// Last-resort safety net: without these the proxy dies silently on any
// unhandled promise rejection. With them it logs and keeps serving.
process.on('unhandledRejection', err => {
  log(`unhandled rejection: ${err}`)
})
process.on('uncaughtException', err => {
  log(`uncaught exception: ${err}`)
})

function enqueue(topic: string, msg: InboundMsg): void {
  const st = getTopic(topic)
  if (inboundModeForRoute(currentRoute(st)) === 'pane') {
    // A proxied Claude runs under API billing, where Claude Code deliberately
    // disables Channels. Never hand its message to a stale /poll waiter: the
    // harness would silently discard it. Queue it for the foreground-pane
    // adapter instead.
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

// Kill a topic's session AND drop the long-polls that belonged to it.
//
// The proxy cannot observe an MCP dying: its /poll waiter stays registered in
// st.waiters until it times out ~25s later. enqueue() prefers a waiter over
// the queue, so a message enqueued in that window is handed to a process that
// no longer exists and is LOST - it never reaches the queue the respawned
// session drains. That is exactly how the first real usage-limit failover
// failed (2026-07-19): the nudge vanished into the killed session, so the
// Claude that came back on its replacement route had nothing to do and sat idle
// while its pane still showed the limit message - looking hung when it was
// actually fine.
//
// Resolving a stale waiter with null just answers 204 to a dead socket, which
// is harmless; the point is to empty the list so the NEXT enqueue queues.
// Always kill through this helper, never mux.kill() directly, when anything
// might be enqueued afterwards.
function killSession(st: TopicState, topic: string): boolean {
  const killed = !!(st.session && mux.liveSessions().has(st.session)) && mux.kill(st.session)
  while (st.waiters.length) st.waiters.shift()?.(null)
  while (st.permWaiters.length) st.permWaiters.shift()?.(null)
  st.session = ''
  st.spawnedAt = 0
  st.launchProfileVersion = undefined
  return killed
}

// ---- multiplexer port -------------------------------------------------------
//
// The domain/application code depends only on this port. Concrete tmux and
// herdr process control lives in adapters/multiplexer.ts.


type PanePumpState = {
  timer?: ReturnType<typeof setTimeout>
  inFlight: boolean
  observedActive: boolean
  submittedAt: number
}

const panePumps = new Map<string, PanePumpState>()

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

function pendingPaneMessage(topic: string, st: TopicState): { message: InboundMsg; resumeNotice: boolean } | undefined {
  if (st.pendingResumeNotice) {
    return {
      message: {
        content: st.pendingResumeNotice,
        meta: {
          chat_id: String(GROUP_CHAT_ID),
          user: 'telegram-topics-proxy',
          ts: new Date().toISOString(),
          ...(topic !== 'general' ? { message_thread_id: topic } : {}),
          route_switch: '1',
        },
      },
      resumeNotice: true,
    }
  }
  const message = st.queue[0]
  return message ? { message, resumeNotice: false } : undefined
}

/**
 * Deliver queued turns to a proxied Claude through its foreground prompt.
 * Claude Code disables Channels under custom API billing, but its normal REPL
 * and MCP tools remain available. We submit only while the pane is idle, wait
 * for the resulting turn to become active and settle, then deliver the next
 * queued turn. The Claude UUID and transcript are untouched.
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
    // A very short turn can finish between status samples. Five seconds after
    // an accepted prompt, an idle pane is safe even if we missed its busy edge.
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

// How long after a spawn we still treat a topic as live even if the multiplexer
// cannot see an agent yet (herdr reports `agent_status: "unknown"` for the first
// ~2s of a pane's life). Generous enough to cover a slow boot, short enough that
// a genuinely failed spawn is retried on the next message.
const SPAWN_GRACE_MS = 30_000

// POST /rate-limit {topic, error, details, reset_at}. The failed user turn is
// already in Claude's transcript. A route with an automatic quota fallback
// resumes the same Claude UUID on that fallback; any other route stops and
// Telegram offers another provider. Either way the resumed session receives a
// one-time nudge to finish that turn.
async function handleRateLimit(req: Request): Promise<Response> {
  const b = parseRateLimit(await req.json())
  const topic = b.topic
  const st = getTopic(topic)
  const label = st.name || topic
  const limitedRoute = st.route ?? DEFAULT_TOPIC_ROUTE
  const returnRoute = quotaReturnRoute(st.exhaustedRoutes, limitedRoute)
  const alreadyReported = exhaustedRouteFor(st.exhaustedRoutes, limitedRoute.provider)
  // A resumed session cannot fail again inside the debounce window, so a report
  // arriving then belongs to the process that was just replaced.
  const justRerouted = Date.now() - (lastRouteChange.get(topic) ?? 0) < ROUTE_DEBOUNCE_MS
  if (justRerouted || (!st.session && alreadyReported && sameRoute(alreadyReported, returnRoute))) {
    return json({ ok: true, provider: limitedRoute.provider, awaiting_selection: true, duplicate: true })
  }
  const resetMs = b.resetAt !== undefined && b.resetAt * 1000 > Date.now()
    ? b.resetAt * 1000
    : undefined
  const resetText = resetMs ? `\nExpected reset: ${formatTime(resetMs)}.` : ''

  const fallback = quotaFallbackRoute(limitedRoute)
  if (fallback && capacities.get(fallback.provider)?.availability !== 'exhausted') {
    st.exhaustedRoutes = rememberExhaustedRoute(st.exhaustedRoutes, limitedRoute)
    st.pendingRoute = undefined
    killSession(st, topic)
    saveRegistry()
    lastRouteChange.set(topic, Date.now())
    const result = requestRouteChange(topic, fallback, 'quota')
    log(`rate limit on topic ${topic} "${label}" for ${limitedRoute.provider}/${limitedRoute.model}; ` +
      `fell back to ${routeSummary(fallback)} (${result})`)
    await bot.api.sendMessage(
      String(GROUP_CHAT_ID),
      `${modelLabel(limitedRoute.model)} reached its usage limit.${resetText}\n` +
        `This session continues on ${routeSummary(fallback)}.`,
      { ...threadOf(topic), reply_markup: switchBackKeyboard(topic, limitedRoute) },
    ).catch(e => log(`quota fallback notice failed for topic ${topic}: ${e}`))
    if (resetMs) scheduleFallbackReturnOffer(topic, limitedRoute, fallback, resetMs)
    return json({ ok: true, provider: limitedRoute.provider, fallback, awaiting_selection: false })
  }

  observeCapacity(providerCapacity(limitedRoute.provider, [{
    name: 'current window',
    usedPercent: 100,
    availability: 'exhausted',
    ...(resetMs ? { resetsAt: resetMs } : {}),
  }], Date.now()))
  st.exhaustedRoutes = rememberExhaustedRoute(st.exhaustedRoutes, returnRoute)
  st.pendingRoute = undefined
  killSession(st, topic)
  saveRegistry()
  log(`rate limit on topic ${topic} "${label}" for ${limitedRoute.provider}/${limitedRoute.model}`)
  await sendProviderPicker(
    String(GROUP_CHAT_ID),
    topic,
    'quota',
    `${providerLabel(limitedRoute.provider)} · ${modelLabel(limitedRoute.model)} reached its usage limit.` +
      resetText +
      `\n\nContinue this same Claude session with:`,
    limitedRoute.provider,
  )
  return json({ ok: true, provider: limitedRoute.provider, awaiting_selection: true })
}

// A model-scoped limit never marks the provider exhausted, so provider capacity
// cannot announce its reset; offer the way back at the reported reset instead.
function scheduleFallbackReturnOffer(topic: string, limited: TopicRoute, fallback: TopicRoute, resetMs: number): void {
  const delay = Math.min(Math.max(1000, resetMs - Date.now() + 1000), 2_147_000_000)
  setTimeout(() => {
    const st = getTopic(topic)
    const recorded = exhaustedRouteFor(st.exhaustedRoutes, limited.provider)
    if (!recorded || !sameRoute(recorded, limited) || !sameRoute(currentRoute(st), fallback)) return
    bot.api.sendMessage(
      String(GROUP_CHAT_ID),
      `${modelLabel(limited.model)} should be available again.`,
      { ...threadOf(topic), reply_markup: switchBackKeyboard(topic, limited) },
    ).catch(e => log(`fallback return offer failed for topic ${topic}: ${e}`))
  }, delay)
}

// POST /capacity is fed by the Claude status-line adapter. External-provider
// capacity is probed directly by their infrastructure adapters.
async function handleCapacity(req: Request): Promise<Response> {
  const body = (await req.json()) as any
  if (body?.provider !== 'anthropic' || !Array.isArray(body?.windows)) {
    return new Response('invalid capacity payload', { status: 400 })
  }
  const windows = body.windows.flatMap((raw: any) => {
    const availability = raw?.availability
    if (!['available', 'exhausted', 'unknown'].includes(availability)) return []
    const usedPercent = Number(raw.used_percent)
    const resetsAt = Number(raw.resets_at)
    return [{
      name: String(raw.name ?? 'window'),
      ...(Number.isFinite(usedPercent) ? { usedPercent } : {}),
      ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
      availability,
    }]
  })
  observeCapacity(providerCapacity('anthropic', windows, Date.now()))
  return json({ ok: true })
}

// POST /turn-failed {topic, error, details} - a topic-Claude's turn died on a
// non-rate-limit API error (529 overloaded, 5xx, auth...). Reported by the
// StopFailure hook. The failed turn already consumed the user's message, so
// without a notice the session just looks like it silently ignored them
// (observed 2026-07-29 during an Anthropic overload incident). Notify-only:
// model switching would not fix these, and the notice rides Telegram's API,
// which survives an Anthropic outage. No debounce by operator choice - keep
// it simple; revisit if an incident ever makes this spammy.
async function handleTurnFailed(req: Request): Promise<Response> {
  const { topic, error: err, details } = parseTurnFailed(await req.json())
  // CONTEXT OVERFLOW, not a fault: the harness classifies an invalid_request
  // carrying this language as "request too large" and responds by
  // auto-compacting, then carries on. Same regex the CLI uses, so we stay in
  // step with it. Reporting these as errors was alarming for a routine,
  // self-healing event (2026-07-31: a long hostthis session tripped it three
  // times).
  const overflow = /\b(too long|too large|exceeds|token limit)\b/i.test(details)
  const overloaded = /overload/i.test(err) || /529/.test(details)
  const st = getTopic(topic)
  const tid = threadIdForTopic(topic)
  const text = overflow
    ? `🗜️ Context filled up, so I'm auto-compacting and carrying on - normal housekeeping, ` +
      `nothing broken. If I go quiet for more than a minute or two, resend your last message.`
    : overloaded
      ? `⚠️ My last turn failed: Anthropic is overloaded (529) - server-side, usually temporary ` +
        `(status.claude.com). Your last message may be unanswered - resend it or say "continue".`
      : `⚠️ My last turn failed with an API error (${err}). Your last message may be unanswered - ` +
        `resend it or say "continue".`
  try {
    await bot.api.sendMessage(String(GROUP_CHAT_ID), text, {
      ...(tid != null ? { message_thread_id: tid } : {}),
    })
    log(`turn-failed notice posted for topic ${topic} "${st.name}" (${err}${overflow ? ', context-overflow/compacting' : ''})`)
    return json({ ok: true })
  } catch (e) {
    log(`turn-failed notice FAILED for topic ${topic}: ${e}`)
    return new Response('send failed', { status: 502 })
  }
}

// GET /topics - the directory tool's backing endpoint.
function handleTopics(): Response {
  return json({ square: SQUARE_TOPIC || null, topics: topicDirectory() })
}

// POST /topic/create {name} - create a forum topic AND register it. Telegram
// never echoes a bot's own actions via getUpdates, so a bot-created topic is
// otherwise invisible to the proxy until a human messages it. Routing creation
// through the proxy closes that hole: the createForumTopic RESPONSE carries the
// thread id, and we register + persist immediately - no user action needed.
// (Requires the bot to be a group admin with can_manage_topics.)
async function handleTopicCreate(req: Request): Promise<Response> {
  const { name, harness } = parseTopicCreate(await req.json())
  // Resolve a viable route before creating the Telegram topic. A catalog/auth
  // failure must not strand an empty forum topic.
  const initialAntigravityRoute = harness === 'antigravity'
    ? await defaultAntigravityRoute()
    : undefined
  const created = await bot.api.createForumTopic(String(GROUP_CHAT_ID), name)
  const topic = String(created.message_thread_id)
  const st = getTopic(topic)
  st.name = name
  topicNames.set(topic, name)
  saveRegistry()
  if (initialAntigravityRoute) {
    antigravityService.activate(antigravityTopic(topic, name, initialAntigravityRoute))
    await antigravityService.start(topic)
  } else if (harness === 'opencode') {
    opencodeService.activate(opencodeTopic(topic, name))
    await opencodeService.start(topic)
  } else if (harness === 'localgen') {
    localgenService.activate(localgenTopic(topic, name))
  }
  log(`created + registered topic ${topic} "${name}"`)
  return json({
    topic,
    thread_id: created.message_thread_id,
    name,
    harness,
    slug: harness === 'claude' ? slugForTopic(topic) : topicSlug(name),
  })
}

// ---- spawn (single-flight) -------------------------------------------------

// Every message to a topic that cannot start retries ensureSession, so its
// failure notice is posted at most once a minute per topic and kind.
const SPAWN_NOTICE_MS = 60_000
const lastSpawnNotice = new Map<string, number>()
function postSpawnNotice(kind: 'missing-conversation' | 'spawn-failed', topic: string, text: string): void {
  const key = `${kind}:${topic}`
  if (Date.now() - (lastSpawnNotice.get(key) ?? 0) < SPAWN_NOTICE_MS) return
  lastSpawnNotice.set(key, Date.now())
  bot.api.sendMessage(String(GROUP_CHAT_ID), text, threadOf(topic))
    .catch(e => log(`${kind} notice failed for topic ${topic}: ${e}`))
}

function reportMissingConversation(topic: string, sessionId: string): void {
  log(`topic ${topic}: claude conversation ${sessionId} not found on disk; not spawning`)
  postSpawnNotice('missing-conversation', topic, missingConversationNotice(sessionId))
}

// Ensure a live Claude Code session exists for a topic. Single-flight: the synchronous
// spawnSync blocks the event loop for the whole launch, so two inbound
// messages for a brand-new topic cannot spawn two sessions; the spawning
// flag + the live-session dedup are belt and suspenders.
function ensureSession(topic: string): void {
  // Harness lock: a locked topic must never fall through to the Claude
  // launcher, even if a stale queue/callback reaches this boundary.
  if (harnessLocked(topic)) return
  // The square topic hosts conversations, not a claude of its own.
  if (SQUARE_TOPIC && topic === SQUARE_TOPIC) return
  const st = getTopic(topic)
  if (st.spawning) return
  const live = mux.liveSessions()
  // Dedup on the RECORDED session name (stable for a live session's whole life;
  // '' for a brand-new / dead topic, so we fall through and spawn). We do NOT
  // re-derive the name here: it now depends on the topic's mutable label, and
  // re-deriving after a rename would miss the running (old-named) session and
  // double-spawn. `live.has(...)` also confirms it is actually up, so a stale
  // recorded name (session died) correctly falls through to a respawn.
  // Boot grace: herdr reports a freshly spawned pane as `agent_status:
  // "unknown"` for ~2s before the agent is detected, and liveSessions() (which
  // now requires a real agent - see HerdrMux) would read that as dead. Without
  // this window, a message arriving in those first seconds would trigger a
  // SECOND spawn on top of the one still booting. Treat anything we spawned very
  // recently as live; after the window, normal liveness applies (so a genuinely
  // failed spawn still gets retried on the next message).
  const bootingGrace =
    !!st.session && st.spawnedAt > 0 && Date.now() - st.spawnedAt < SPAWN_GRACE_MS
  if (st.session && (live.has(st.session) || bootingGrace)) {
    if (!st.spawnedAt) {
      st.spawnedAt = Date.now()
      saveRegistry()
    }
    return
  }
  // Migration bridge: an OLD-scheme `tg-<cid>-<tid>` session may be live but
  // UNTRACKED (predates session-id tracking, or the registry was lost), so
  // reconcile never recorded it in st.session. Adopt it by its legacy name
  // instead of spawning a SECOND session under the new name (the launcher's
  // has-session guard keys off the new name, so it would not catch the old one).
  // It gets the new name on its next respawn. Removable once no `tg-*` remain.
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
  // A topic bound to a conversation must resume THAT conversation. If its file is
  // gone, starting a fresh one would silently drop the topic's history, so report
  // it in the topic and start nothing; /relaunch is the explicit way out.
  if (st.claudeSessionId && !claudeConversationExists(st.claudeSessionId)) {
    reportMissingConversation(topic, st.claudeSessionId)
    return
  }
  st.spawning = true
  try {
    const label = st.name || topicNames.get(topic) || topic
    st.name = label
    // The topic is bound to a new conversation only once its launch succeeds: a
    // failed first launch leaves no transcript, and a binding to it would read
    // as a missing conversation on every later message.
    const conversation = spawnConversation(st.claudeSessionId, () => crypto.randomUUID())
    const resuming = conversation.resume
    const route = st.route ?? DEFAULT_TOPIC_ROUTE
    st.route = route
    // Name the mux session from the CURRENT label (fresh each spawn, so a
    // rename takes effect on the next respawn); recorded in st.session after a
    // successful spawn so dedup + kill target this exact string.
    const name = sessionNameFor(topic, label)
    // Regenerate the effective settings for THIS spawn so it reflects the current
    // committed base + the ultracode config (fresh on every respawn).
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

// ---- grammy inbound --------------------------------------------------------

const bot = new Bot(TOKEN, BOT_API_ROOT ? { client: { apiRoot: BOT_API_ROOT } } : undefined)
const downloadFile = telegramDownloader(bot.api, TOKEN, INBOX_DIR, log)
const { topicDirectory, slugForTopic, handleSquareTag, handleSquareReply, handleSquareUserMessage } = createSquare({
  api: bot.api,
  harnessLocked,
  ensureSession,
  enqueue,
})

// Antigravity is a separate harness-bounded context. It shares only the one
// Telegram Bot API adapter with Claude topics; its session identity, model
// catalog, route, and persistence are deliberately separate.
const antigravityRepository = new JsonTopicRepository<AntigravityTopic>(
  ANTIGRAVITY_TOPICS_FILE, 'Antigravity', antigravityTopicFromRecord,
)
const antigravityRuntime = ANTIGRAVITY_ENABLED
  ? new HerdrAntigravityRuntime(ANTIGRAVITY_BIN, SPAWN_DIR, HERDR_LAUNCH_SCRIPT, PROXY_URL)
  : new DisabledAntigravityRuntime()
const antigravityService = new AntigravityTopicService(
  antigravityRepository,
  antigravityRuntime,
  {
    typing(topic) {
      void bot.api.sendChatAction(String(GROUP_CHAT_ID), 'typing', threadOf(topic)).catch(() => {})
    },
    async error(topic, text) {
      log(`Antigravity turn failed for topic ${topic}: ${text}`)
      await bot.api.sendMessage(
        String(GROUP_CHAT_ID),
        `⚠️ ${text.slice(0, MAX_CHUNK_LIMIT - 3)}`,
        threadOf(topic),
      )
      if (/limit|quota|resource exhausted/i.test(text)) void refreshAntigravityUsage(true).catch(() => {})
    },
  },
)

// OpenCode (localcode) is a third harness-bounded context: one local Qwen
// model, no route or usage, persisted in its own file. It shares only the
// Telegram Bot API adapter with the other two.
const opencodeRepository = new JsonTopicRepository<OpencodeTopic>(OPENCODE_TOPICS_FILE, 'OpenCode', opencodeTopicFromRecord)
const opencodeRuntime = new HerdrOpencodeRuntime(
  OPENCODE_BIN,
  OPENCODE_PROJECT_DIR,
  HERDR_LAUNCH_SCRIPT,
  PROXY_URL,
  process.execPath,
  join(PLUGIN_ROOT, 'server.ts'),
  undefined,
  undefined,
  undefined,
  OPENCODE_MODEL,
)
// Last /send per locked OpenCode topic; the service's reply backstop reads it.
const opencodeLastSentAt = new Map<string, number>()
const opencodeService = new OpencodeTopicService(
  opencodeRepository,
  opencodeRuntime,
  {
    typing(topic) {
      void bot.api.sendChatAction(String(GROUP_CHAT_ID), 'typing', threadOf(topic)).catch(() => {})
    },
    async error(topic, text) {
      log(`OpenCode turn failed for topic ${topic}: ${text}`)
      await bot.api.sendMessage(
        String(GROUP_CHAT_ID),
        `⚠️ ${text.slice(0, MAX_CHUNK_LIMIT - 3)}`,
        threadOf(topic),
      )
    },
    repliedSince(topic, sinceMs) {
      return (opencodeLastSentAt.get(topic) ?? 0) >= sinceMs
    },
    async notice(topic, text) {
      log(`OpenCode reply backstop for topic ${topic}: ${text.slice(0, 80)}`)
      await bot.api.sendMessage(
        String(GROUP_CHAT_ID),
        `↩︎ ${text.slice(0, MAX_CHUNK_LIMIT - 2)}`,
        threadOf(topic),
      )
    },
  },
)

// Records without a Herdr session name are started at boot so an enabled
// topic is visible without a throwaway Telegram turn.
for (const topic of opencodeService.list()) {
  if (topic.sessionName) continue
  void opencodeService.start(topic.topic)
    .then(running => log(
      `started OpenCode topic ${topic.topic} "${topic.name}" in Herdr ` +
      `${running.sessionName} (${running.opencodeSessionId})`,
    ))
    .catch(error => log(`OpenCode Herdr start failed for topic ${topic.topic}: ${error}`))
}

// localgen is a fourth harness-bounded context with no agent at all: every
// text message is an image prompt POSTed to the qwen-image server and the PNG
// comes back into the same thread.
const localgenRepository = new JsonTopicRepository<LocalgenTopic>(LOCALGEN_TOPICS_FILE, 'localgen', localgenTopicFromRecord)
const localgenService = new LocalgenTopicService(
  localgenRepository,
  new QwenImageClient(LOCALGEN_URL, log),
  {
    uploading(topic) {
      void bot.api.sendChatAction(String(GROUP_CHAT_ID), 'upload_photo', threadOf(topic)).catch(() => {})
    },
    // Telegram refuses a photo over 10 MB or with a side past its limits; the
    // document form carries any PNG, so it is the fallback as well as `raw`.
    async photo(topic, png, filename, caption, asDocument) {
      const file = new InputFile(png, filename)
      const opts = { ...threadOf(topic), caption }
      if (!asDocument) {
        try {
          await bot.api.sendPhoto(String(GROUP_CHAT_ID), file, opts)
          return
        } catch (error) {
          log(`localgen sendPhoto failed for topic ${topic}, sending as document: ${error}`)
        }
      }
      await bot.api.sendDocument(String(GROUP_CHAT_ID), new InputFile(png, filename), opts)
    },
    async queued(topic, position) {
      await bot.api.sendMessage(String(GROUP_CHAT_ID), `queued (#${position})`, threadOf(topic))
    },
    async error(topic, text) {
      log(`localgen failed for topic ${topic}: ${text}`)
      await bot.api.sendMessage(
        String(GROUP_CHAT_ID),
        `⚠️ ${text.slice(0, MAX_CHUNK_LIMIT - 3)}`,
        threadOf(topic),
      )
    },
  },
  LOCALGEN_START_CMD,
)

function topicHarnessOf(topic: string): TopicHarness {
  if (antigravityService.isLocked(topic)) return 'antigravity'
  if (opencodeService.isLocked(topic)) return 'opencode'
  if (localgenService.isLocked(topic)) return 'localgen'
  return 'claude'
}

// True for every harness that owns the topic instead of a Claude pane.
function harnessLocked(topic: string): boolean {
  return topicHarnessOf(topic) !== 'claude'
}

// Says why `topic` cannot be locked to `harness` and returns false, or returns
// true when it can (including when it already is).
async function mayLockTopic(chatId: string, topic: string, fromId: string, harness: LockedHarness): Promise<boolean> {
  const claude = getTopic(topic)
  const refusal = lockRefusal({
    harness,
    byOperator: !!ADMIN_USER_ID && fromId === ADMIN_USER_ID,
    inSquare: !!SQUARE_TOPIC && topic === SQUARE_TOPIC,
    current: topicHarnessOf(topic),
    ownsClaudeConversation: !!(claude.claudeSessionId || claude.session),
  })
  if (refusal) await sayIn(chatId, topic, refusal)
  return !refusal
}

function syncAntigravityInterop(): void {
  const roots = [
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.claude', 'skills'),
    ...claudePluginSkillRoots(
      join(homedir(), '.claude', 'settings.json'),
      join(homedir(), '.claude', 'plugins', 'installed_plugins.json'),
      // The proxy itself is the Telegram adapter. Importing either Claude
      // Telegram plugin would start incompatible channel mechanics and risks a
      // second getUpdates consumer for the same token.
      new Set(['telegram']),
    ),
  ]
  try {
    const mcpChanged = syncAntigravityTelegramMcp(
      join(homedir(), '.gemini', 'config', 'mcp_config.json'),
      process.execPath,
      join(PLUGIN_ROOT, 'server.ts'),
    )
    const result = syncAntigravitySkills(
      join(homedir(), '.gemini', 'antigravity-cli', 'skills'),
      roots,
    )
    log(
      `Antigravity interop: Telegram MCP ${mcpChanged ? 'configured' : 'current'}; ` +
      `${result.linked.length} skills linked, ${result.skipped.length} native/existing preserved`,
    )
  } catch (error) {
    log(`Antigravity skill interop failed (turns still work): ${error}`)
  }
}

if (ANTIGRAVITY_ENABLED) syncAntigravityInterop()

// One-time migration from the original headless pilot: those records have no
// Herdr session name. Start them now so an already-enabled topic becomes
// visible without requiring the operator to send a throwaway Telegram turn.
for (const topic of ANTIGRAVITY_ENABLED ? antigravityService.list() : []) {
  if (topic.sessionName) continue
  void antigravityService.start(topic.topic)
    .then(running => log(
      `migrated Antigravity topic ${topic.topic} "${topic.name}" to Herdr ` +
      `${running.sessionName} (${running.conversationId})`,
    ))
    .catch(error => log(`Antigravity Herdr migration failed for topic ${topic.topic}: ${error}`))
}

bot.catch(err => {
  process.stderr.write(`telegram-topics-proxy: handler error (polling continues): ${err.error}\n`)
})

// A "/secret <name>" message is stored to SECRETS_DIR and deleted from the
// chat without ever being enqueued: a topic-Claude's transcript persists every
// inbound message in plaintext, so the value must not reach one. The ack names
// the path and the byte count, never the value, and it is the whole notice: a
// Claude is not woken or told, it reads the file when asked to use it.
async function handleSecretDrop(
  chatId: string, topic: string, msgId: number, fromId: string, text: string,
): Promise<void> {
  const say = (t: string) =>
    bot.api.sendMessage(chatId, t, threadOf(topic)).catch(noticeFailed('secret notice', topic))
  // Delete before validating: a refused name must not leave the value on screen.
  let deleted = true
  try {
    await bot.api.deleteMessage(chatId, msgId)
  } catch {
    deleted = false
  }
  const undeleted = deleted ? '' : ' Could NOT delete your message; remove it yourself.'
  if (!SECRETS_USER_ID || fromId !== SECRETS_USER_ID) {
    log(`secret drop refused from user ${fromId}`)
    await say(`🔐 refused: not the secrets user.${undeleted}`)
    return
  }
  const cmd = parseSecretCommand(text)
  if ('error' in cmd) {
    await say(`🔐 ${cmd.error}.${undeleted}`)
    return
  }
  if (cmd.kind === 'begin') {
    // A menu tap sends the bare verb, so a bare verb opens the guided flow.
    await cancelSecretFlow(chatId, fromId, topic)
    await promptSecret(chatId, topic, fromId, beginSecretFlow(cmd.verb), [])
    return
  }
  if (cmd.kind === 'list') {
    const entries = listSecrets(SECRETS_DIR)
    let body = entries.map(e => `${e.name}  ${e.bytes} bytes  ${e.mtime.toISOString().slice(0, 10)}`).join('\n')
    if (body.length > 3500) body = body.slice(0, 3500) + '\n... truncated'
    await say(`🔐 ${tilde(SECRETS_DIR)}: ${entries.length} secret(s)\n${body}${undeleted}`)
    return
  }
  if (cmd.kind === 'delete') {
    await deleteAndAck(chatId, topic, fromId, cmd.name, undeleted)
    return
  }
  await storeAndAck(chatId, topic, fromId, cmd.name, cmd.value, cmd.replace, undeleted)
}

// ---- guided flow -------------------------------------------------------------
// A bare /secret or /unsecret opens a prompt exchange (name, then value). The
// state is keyed by user AND topic and expires, so a stale flow can never
// swallow an unrelated message. Every message in the exchange is deleted and
// only the final ack stays.

type PendingFlow = { pending: Pending; prompts: number[]; at: number }
const pendingSecrets = new Map<string, PendingFlow>()
const SECRET_FLOW_TTL_MS = 5 * 60_000
const flowKey = (fromId: string, topic: string) => `${fromId}:${topic}`

function pendingSecretFlow(fromId: string, topic: string): PendingFlow | undefined {
  const key = flowKey(fromId, topic)
  const flow = pendingSecrets.get(key)
  if (!flow) return undefined
  if (Date.now() - flow.at > SECRET_FLOW_TTL_MS) {
    pendingSecrets.delete(key)
    return undefined
  }
  return flow
}

// ForceReply opens the reply box on the phone with the placeholder shown.
async function promptSecret(
  chatId: string, topic: string, fromId: string, result: FlowResult, prompts: number[],
): Promise<void> {
  if (result.kind !== 'prompt') return
  const sent = await bot.api
    .sendMessage(chatId, result.text, {
      ...threadOf(topic),
      reply_markup: { force_reply: true, input_field_placeholder: result.placeholder },
    })
    .catch(() => null)
  if (sent) prompts.push(sent.message_id)
  pendingSecrets.set(flowKey(fromId, topic), { pending: result.next, prompts, at: Date.now() })
}

async function cancelSecretFlow(chatId: string, fromId: string, topic: string): Promise<void> {
  const key = flowKey(fromId, topic)
  const flow = pendingSecrets.get(key)
  if (!flow) return
  pendingSecrets.delete(key)
  await deleteMessages(chatId, flow.prompts)
}

async function deleteMessages(chatId: string, ids: number[]): Promise<void> {
  for (const id of ids) await bot.api.deleteMessage(chatId, id).catch(() => {})
}

// One step of the flow. The user's message is deleted first whatever it holds.
async function handleSecretStep(
  chatId: string, topic: string, msgId: number, fromId: string, text: string, flow: PendingFlow,
): Promise<void> {
  pendingSecrets.delete(flowKey(fromId, topic))
  let deleted = true
  try {
    await bot.api.deleteMessage(chatId, msgId)
  } catch {
    deleted = false
  }
  const undeleted = deleted ? '' : ' Could NOT delete your message; remove it yourself.'
  const r = advanceSecretFlow(flow.pending, text, name => secretExists(SECRETS_DIR, name))
  if (r.kind === 'prompt') {
    await promptSecret(chatId, topic, fromId, r, flow.prompts)
    return
  }
  await deleteMessages(chatId, flow.prompts)
  if (r.kind === 'cancelled') {
    await sayIn(chatId, topic, `🔐 cancelled.${undeleted}`)
    return
  }
  if (r.kind === 'delete') {
    await deleteAndAck(chatId, topic, fromId, r.name, undeleted)
    return
  }
  await storeAndAck(chatId, topic, fromId, r.name, r.value, r.replace, undeleted)
}

async function storeAndAck(
  chatId: string, topic: string, fromId: string, name: string, value: string, replace: boolean, undeleted: string,
): Promise<void> {
  const shown = tilde(join(SECRETS_DIR, name))
  let stored
  try {
    stored = storeSecret(SECRETS_DIR, name, value, replace)
  } catch (err) {
    if (err instanceof SecretExists) {
      log(`secret drop refused: ${shown} exists`)
      await sayIn(
        chatId, topic,
        `🔐 refused: ${shown} exists (${err.bytes} bytes). Resend as /secret ${name} --replace to overwrite it.${undeleted}`,
      )
      return
    }
    log(`secret drop failed for ${name}: ${err}`)
    await sayIn(chatId, topic, `🔐 could not store "${name}": ${reason(err)}.${undeleted}`)
    return
  }
  const note = `${stored.replaced ? 'replaced' : 'stored'} ${shown} (${stored.bytes} bytes)`
  log(`secret drop: ${note}`)
  await sayIn(chatId, topic, `🔐 ${note}.${undeleted}`)
  notifyTopic(chatId, topic, fromId, `the operator ${note}. Read the file when a task needs it; the value was deliberately never sent to you.`)
}

async function deleteAndAck(
  chatId: string, topic: string, fromId: string, name: string, undeleted: string,
): Promise<void> {
  const shown = tilde(join(SECRETS_DIR, name))
  try {
    const gone = deleteSecret(SECRETS_DIR, name)
    log(`secret drop: deleted ${shown}`)
    await sayIn(chatId, topic, `🔐 deleted ${shown} (${gone.bytes} bytes).${undeleted}`)
    notifyTopic(chatId, topic, fromId, `the operator deleted the secret ${shown}.`)
  } catch (err) {
    const why = err instanceof SecretMissing ? `no such secret: ${shown}` : `could not delete ${shown}: ${reason(err)}`
    await sayIn(chatId, topic, `🔐 ${why}.${undeleted}`)
  }
}

// The topic's Claude learns the path, never the value, through the same queue
// a message takes (waking it if dormant), so nobody has to tell it. The square
// has no Claude of its own. secret_drop=1 lets the reply guard accept silence:
// the proxy already acked in the topic.
function notifyTopic(chatId: string, topic: string, fromId: string, what: string): void {
  if ((SQUARE_TOPIC && topic === SQUARE_TOPIC) || harnessLocked(topic)) return
  ensureSession(topic)
  enqueue(topic, {
    content: `SYSTEM NOTICE (not a user message): ${what} No reply is required.`,
    meta: {
      chat_id: chatId,
      user: 'telegram-topics-proxy',
      user_id: fromId,
      ts: new Date().toISOString(),
      ...(topic !== 'general' ? { message_thread_id: topic } : {}),
      ...SECRET_DROP_META,
    },
  })
}

const threadOf = (topic: string) => (topic === 'general' ? {} : { message_thread_id: Number(topic) })
// A message meant for the operator that Telegram refused is logged, never dropped silently.
const noticeFailed = (what: string, topic: string) => (err: unknown) =>
  log(`${what} not sent in topic ${topic}: ${err instanceof Error ? err.message : String(err)}`)
const sayIn = (chatId: string, topic: string, t: string) =>
  bot.api.sendMessage(chatId, t, threadOf(topic)).catch(noticeFailed('notice', topic))
const tilde = (p: string) => (p.startsWith(homedir() + sep) ? '~' + p.slice(homedir().length) : p)
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---- reminders ----------------------------------------------------------------
//
// An agent's own scheduler dies with its session, so reminders live here. At
// fire time the proxy posts the text itself, which reaches the operator even if
// the agent cannot start, then wakes the agent for any follow-up it asked for.
const reminders = loadReminders()
let firingReminders = false

// An unreadable file must not take the whole bridge down: set it aside, loudly.
function loadReminders(): JsonReminderRepository {
  try {
    return new JsonReminderRepository(REMINDERS_FILE)
  } catch (err) {
    const aside = `${REMINDERS_FILE}.unreadable-${Date.now()}`
    try { renameSync(REMINDERS_FILE, aside) } catch {}
    log(`reminders: could not load ${REMINDERS_FILE} (${reason(err)}); moved to ${aside}, starting empty`)
    return new JsonReminderRepository(REMINDERS_FILE)
  }
}

async function handleRemind(req: Request): Promise<Response> {
  const b = (await req.json()) as ReminderRequest
  const topic = String(b.topic ?? '')
  // A reminder wakes its topic, and ensureSession would spawn an agent for a
  // topic that does not exist.
  if (!topicDirectory().some(e => e.topic === topic)) return new Response(`unknown topic: ${topic}`, { status: 400 })
  try {
    const r = scheduleReminder(b, Date.now(), crypto.randomUUID().replace(/-/g, '').slice(0, 8))
    reminders.add(r)
    log(`reminder ${r.id} set for topic ${topic} at ${r.atText}`)
    return json({ id: r.id, at: r.atText })
  } catch (err) {
    if (err instanceof InvalidReminder) return new Response(err.message, { status: 400 })
    throw err
  }
}

function handleListReminders(url: URL): Response {
  const topic = url.searchParams.get('topic') ?? ''
  const mine = reminders
    .list()
    .filter(r => r.topic === topic)
    .sort((a, b) => a.at - b.at)
    .map(r => ({ id: r.id, at: r.atText, text: r.text, ...(r.prompt ? { prompt: r.prompt } : {}) }))
  return json({ reminders: mine })
}

async function handleCancelReminder(req: Request): Promise<Response> {
  const { topic, id } = parseCancelReminder(await req.json())
  const r = reminders.list().find(x => x.id === id)
  if (!r || r.topic !== topic) return new Response(`no reminder ${id} in this topic`, { status: 404 })
  reminders.remove(id)
  log(`reminder ${id} cancelled`)
  return json({ cancelled: id })
}

async function fireDueReminders(): Promise<void> {
  if (firingReminders) return
  firingReminders = true
  try {
    const chatId = String(GROUP_CHAT_ID)
    const now = Date.now()
    for (const r of dueReminders(reminders.list(), now)) {
      try {
        await bot.api.sendMessage(chatId, `⏰ ${r.text}`, threadOf(r.topic))
      } catch (err) {
        log(`reminder ${r.id}: post failed, retrying next tick: ${reason(err)}`)
        continue
      }
      if (!(SQUARE_TOPIC && r.topic === SQUARE_TOPIC) && !harnessLocked(r.topic)) {
        ensureSession(r.topic)
        enqueue(r.topic, {
          content: reminderNotice(r, now),
          meta: {
            chat_id: chatId,
            user: 'telegram-topics-proxy',
            user_id: '',
            ts: new Date(now).toISOString(),
            ...(r.topic !== 'general' ? { message_thread_id: r.topic } : {}),
            ...reminderMeta(!!r.prompt),
          },
        })
      }
      reminders.remove(r.id)
      log(`reminder ${r.id} fired in topic ${r.topic}${now - r.at > LATE_AFTER_MS ? ' (late)' : ''}`)
    }
  } finally {
    firingReminders = false
  }
}

// ---- Google Antigravity harness -------------------------------------------

type AntigravityModelSelection = {
  topic: string
  model: AntigravityModel
  expiresAt: number
}

const antigravityModelSelections = new Map<string, AntigravityModelSelection>()
let antigravityCatalogCache: { models: AntigravityModel[]; at: number } | undefined
let antigravityUsageSnapshot: AntigravityUsageWindow[] = []

async function antigravityModels(force = false): Promise<AntigravityModel[]> {
  if (!force && antigravityCatalogCache && Date.now() - antigravityCatalogCache.at < 60_000) {
    return antigravityCatalogCache.models
  }
  const models = await antigravityService.models()
  antigravityCatalogCache = { models, at: Date.now() }
  return models
}

async function defaultAntigravityRoute() {
  const models = await antigravityModels()
  const model = models.find(candidate => candidate.id === 'gemini-3.8-flash') ?? models[0]
  if (!model) throw new Error('Antigravity has no available subscription models')
  return antigravityRoute(model, model.defaultEffort)
}

function antigravitySelection(model: AntigravityModel, topic: string): string {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  antigravityModelSelections.set(token, {
    topic,
    model,
    expiresAt: Date.now() + PICKER_TTL_MS,
  })
  return token
}

function pruneAntigravitySelections(): void {
  const now = Date.now()
  for (const [token, selection] of antigravityModelSelections) {
    if (selection.expiresAt < now) antigravityModelSelections.delete(token)
  }
}

async function antigravityModelPicker(
  topic: string,
  page = 0,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  pruneAntigravitySelections()
  const models = await antigravityModels()
  const pages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE))
  const safePage = Math.max(0, Math.min(page, pages - 1))
  const keyboard = new InlineKeyboard()
  for (const model of models.slice(safePage * MODELS_PER_PAGE, (safePage + 1) * MODELS_PER_PAGE)) {
    keyboard.text(model.label, encodeCallback({ kind: 'antigravity-model', token: antigravitySelection(model, topic) })).row()
  }
  if (pages > 1) {
    if (safePage > 0) keyboard.text('Previous', encodeCallback({ kind: 'antigravity-models', topic, page: safePage - 1 }))
    if (safePage + 1 < pages) keyboard.text('Next', encodeCallback({ kind: 'antigravity-models', topic, page: safePage + 1 }))
    keyboard.row()
  }
  keyboard.text('Usage', encodeCallback({ kind: 'antigravity-usage', topic }))
  return {
    text: `Google / Antigravity subscription models${pages > 1 ? ` (${safePage + 1}/${pages})` : ''}:`,
    keyboard,
  }
}

function antigravityUsageText(windows: Awaited<ReturnType<AntigravityTopicService['usage']>>): string {
  if (!windows.length) return 'Antigravity subscription usage is temporarily unavailable.'
  const pools = new Map<string, typeof windows>()
  for (const window of windows) {
    const list = pools.get(window.pool) ?? []
    list.push(window)
    pools.set(window.pool, list)
  }
  const lines = [...pools.entries()].map(([pool, values]) =>
    `${pool}:\n${values.map(value =>
      `  ${value.window}: ${value.remainingPercent}% remaining, resets ${formatTime(value.resetsAt)}`,
    ).join('\n')}`,
  )
  return `Google / Antigravity subscription usage\n\n${lines.join('\n\n')}`
}

async function refreshAntigravityUsage(notifyResets: boolean): Promise<AntigravityUsageWindow[]> {
  if (!ANTIGRAVITY_ENABLED || !antigravityService.list().length) return []
  try {
    const current = await antigravityService.usage()
    const resets = notifyResets ? antigravityResetPools(antigravityUsageSnapshot, current) : []
    antigravityUsageSnapshot = current
    for (const pool of resets) {
      for (const topic of antigravityService.list()) {
        await bot.api.sendMessage(
          String(GROUP_CHAT_ID),
          `${pool} is available again on your Google / Antigravity subscription. ` +
          'This topic was not switched automatically.',
          {
            ...threadOf(topic.topic),
            reply_markup: new InlineKeyboard()
              .text('Choose Antigravity model', encodeCallback({ kind: 'antigravity-models', topic: topic.topic, page: 0 })),
          },
        ).catch(error => log(`Antigravity reset notice failed for topic ${topic.topic}: ${error}`))
      }
    }
    return current
  } catch (error) {
    log(`Antigravity capacity probe failed: ${error}`)
    throw error
  }
}

async function activateAntigravityTopic(
  chatId: string,
  topic: string,
  fromId: string,
): Promise<void> {
  if (!(await mayLockTopic(chatId, topic, fromId, 'antigravity'))) return
  if (!ANTIGRAVITY_ENABLED) {
    await sayIn(chatId, topic, ANTIGRAVITY_DISABLED_MESSAGE)
    return
  }
  const existing = antigravityService.get(topic)
  if (existing) {
    try {
      const running = await antigravityService.start(topic)
      await sayIn(
        chatId,
        topic,
        `This topic is already locked to ${antigravityRouteLabel(running.route)} in Herdr workspace ` +
        `${running.sessionName}. Conversation: ${running.conversationId}.`,
      )
    } catch (error) {
      await sayIn(chatId, topic, `Could not start the existing Antigravity session: ${reason(error)}`)
    }
    return
  }
  const claude = getTopic(topic)
  try {
    const route = await defaultAntigravityRoute()
    const name = claude.name || topicNames.get(topic) || `Antigravity ${topic}`
    antigravityService.activate(antigravityTopic(topic, name, route))
    claude.name = name
    topicNames.set(topic, name)
    saveRegistry()
    void refreshAntigravityUsage(false).catch(() => {})
    await sayIn(chatId, topic, `Starting ${antigravityRouteLabel(route)} in a persistent Herdr workspace…`)
    const running = await antigravityService.start(topic)
    await sayIn(
      chatId,
      topic,
      `Locked this topic to ${antigravityRouteLabel(route)} in Herdr workspace ${running.sessionName}. ` +
      `Conversation: ${running.conversationId}. Other harness/provider routes are disabled here. ` +
      'Use /model to switch only among models included with the Antigravity subscription.',
    )
  } catch (error) {
    await sayIn(chatId, topic, `Could not enable Antigravity: ${reason(error)}`)
  }
}

async function handleAntigravityModelCommand(
  chatId: string,
  topic: string,
  fromId: string,
  arg: string,
): Promise<void> {
  if (!ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
    await sayIn(chatId, topic, 'Only the operator can change this topic\'s model.')
    return
  }
  const current = antigravityService.get(topic)!
  const value = arg.trim().toLowerCase()
  if (value === 'status') {
    await sayIn(
      chatId,
      topic,
      `Antigravity conversation: ${current.conversationId ?? 'not started'}\n` +
      `Route: ${antigravityRouteLabel(current.route)}\n` +
      `Herdr: ${current.sessionName ?? 'not running'} (${await antigravityService.status(topic)})\n` +
      'Harness: Antigravity (locked)\nPermissions: non-interactive; no hard gates\n' +
      'Context: AGENTS.md/GEMINI.md native; CLAUDE.md and Markdown skills via compatibility adapter',
    )
    return
  }
  if (value) {
    await sayIn(
      chatId,
      topic,
      'This topic is harness-locked to Google / Antigravity. Run bare /model and choose from its subscription catalog.',
    )
    return
  }
  try {
    const picker = await antigravityModelPicker(topic)
    await bot.api.sendMessage(chatId, picker.text, { ...threadOf(topic), reply_markup: picker.keyboard })
  } catch (error) {
    await sayIn(chatId, topic, `Could not load Antigravity models: ${reason(error)}`)
  }
}

// ---- OpenCode (localcode) harness ------------------------------------------

const opencodeRouteLabel = () => `OpenCode / local Qwen · ${OPENCODE_MODEL}`

async function activateLocalcodeTopic(
  chatId: string,
  topic: string,
  fromId: string,
): Promise<void> {
  if (!(await mayLockTopic(chatId, topic, fromId, 'opencode'))) return
  const existing = opencodeService.get(topic)
  if (existing) {
    try {
      const running = await opencodeService.start(topic)
      await sayIn(
        chatId,
        topic,
        `This topic is already locked to ${opencodeRouteLabel()} in Herdr workspace ` +
        `${running.sessionName}. Session: ${running.opencodeSessionId}.`,
      )
    } catch (error) {
      await sayIn(chatId, topic, `Could not start the existing OpenCode session: ${reason(error)}`)
    }
    return
  }
  const claude = getTopic(topic)
  try {
    const name = claude.name || topicNames.get(topic) || `localcode ${topic}`
    opencodeService.activate(opencodeTopic(topic, name))
    claude.name = name
    topicNames.set(topic, name)
    saveRegistry()
    await sayIn(chatId, topic, 'Starting OpenCode on the local Qwen model in a persistent Herdr workspace…')
    const running = await opencodeService.start(topic)
    await sayIn(
      chatId,
      topic,
      `Locked this topic to OpenCode / local Qwen (${OPENCODE_MODEL}) in Herdr workspace ${running.sessionName}. ` +
      `Session: ${running.opencodeSessionId}. Other harness/provider routes are disabled here. ` +
      'The first reply takes a few minutes while OpenCode loads its instructions.',
    )
  } catch (error) {
    await sayIn(chatId, topic, `Could not enable OpenCode: ${reason(error)}`)
  }
}

// Single-model harness: /model only reports status, there is nothing to pick.
async function handleOpencodeModelCommand(chatId: string, topic: string, argument: string): Promise<void> {
  const current = opencodeService.get(topic)!
  await sayIn(
    chatId,
    topic,
    `OpenCode session: ${current.opencodeSessionId ?? 'not started'}\n` +
    `Route: ${opencodeRouteLabel()}\n` +
    `Herdr: ${current.sessionName ?? 'not running'} (${await opencodeService.status(topic)})\n` +
    'Harness: OpenCode (locked)\nPermissions: OpenCode defaults\n' +
    'Context: AGENTS.md and ~/.claude/CLAUDE.md native' +
    (argument ? '\n\nThis topic runs a single local model, so there is nothing to pick.' : ''),
  )
}

// ---- localgen harness --------------------------------------------------------

const localgenRouteLabel = () => `qwen-image · ${LOCALGEN_URL}`

// Locks the topic the command was posted in, like /localcode: admin only,
// never the square, never a topic another harness or a Claude UUID owns. The
// argument renames the topic record; without one the learned name is kept.
async function activateLocalgenTopic(
  chatId: string,
  topic: string,
  fromId: string,
  argument: string,
): Promise<void> {
  if (!(await mayLockTopic(chatId, topic, fromId, 'localgen'))) return
  if (localgenService.isLocked(topic)) {
    await sayIn(chatId, topic, `This topic is already locked to ${localgenRouteLabel()}.`)
    return
  }
  const claude = getTopic(topic)
  try {
    const name = argument.trim() || claude.name || topicNames.get(topic) || 'localgen'
    localgenService.activate(localgenTopic(topic, name))
    claude.name = name
    topicNames.set(topic, name)
    saveRegistry()
    await sayIn(
      chatId,
      topic,
      `Locked this topic to ${localgenRouteLabel()}. Every text message here is an image prompt; ` +
      'options: size:WxH steps:N seed:N n:K raw. No agent runs in this topic.',
    )
  } catch (error) {
    await sayIn(chatId, topic, `Could not enable localgen: ${reason(error)}`)
  }
}

// Single-model harness: /model only reports status, there is nothing to pick.
async function handleLocalgenModelCommand(chatId: string, topic: string, argument: string): Promise<void> {
  let health = 'not listening'
  try {
    const response = await fetch(`${LOCALGEN_URL}/healthz`, { signal: AbortSignal.timeout(3_000) })
    const body = (await response.json().catch(() => ({}))) as any
    health = `${body.status ?? response.status}` +
      (body.busy != null ? `, busy ${body.busy}, queued ${body.queued}` : '')
  } catch {}
  await sayIn(
    chatId,
    topic,
    `Route: ${localgenRouteLabel()}\nServer: ${health}\n` +
    'Harness: localgen (locked)\nPermissions: none, nothing runs but the generator\n' +
    'Options: size:WxH steps:N seed:N n:K raw' +
    (argument ? '\n\nThis topic runs a single local model, so there is nothing to pick.' : ''),
  )
}

// Same kill-then-nudge sequence as a provider-route recovery: killSession
// drains the dying MCP's long-polls first so the nudge cannot be handed to it
// and lost. The nudge asks for one line back, so a respawn that fails is a
// visible silence rather than a quiet one.
async function handleRelaunch(chatId: string, topic: string, fromId: string): Promise<void> {
  if (antigravityService.isLocked(topic)) {
    const current = antigravityService.get(topic)!
    const result = await antigravityService.requestRelaunch(topic)
    await sayIn(
      chatId,
      topic,
      result.pending
        ? `Antigravity is busy; relaunch is queued for the next idle boundary. It will keep conversation ` +
          `${current.conversationId ?? 'not started'} and reopen in Herdr.`
        : `Relaunched Antigravity in Herdr with the same conversation ` +
          `${result.topic.conversationId ?? 'not started'} and freshly loaded MCP/configuration.`,
    )
    return
  }
  if (opencodeService.isLocked(topic)) {
    const current = opencodeService.get(topic)!
    const result = await opencodeService.requestRelaunch(topic)
    await sayIn(
      chatId,
      topic,
      result.pending
        ? `OpenCode is busy; relaunch is queued for the next idle boundary. It will keep session ` +
          `${current.opencodeSessionId ?? 'not started'} and reopen in Herdr.`
        : `Relaunched OpenCode in Herdr with the same session ` +
          `${result.topic.opencodeSessionId ?? 'not started'} and freshly loaded MCP/configuration.`,
    )
    return
  }
  if (localgenService.isLocked(topic)) {
    await sayIn(chatId, topic, 'localgen runs no agent; there is nothing to relaunch. Restart the qwen-image server from the gpu topic if needed.')
    return
  }
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

// ---- provider routing application service + Telegram adapter ---------------

const capacities = new Map<ProviderId, ProviderCapacity>()
type ModelSelection = {
  topic: string
  provider: ProviderId
  model: ProviderModel
  reason: PickerReason
  expiresAt: number
  effort?: Effort
}
const modelSelections = new Map<string, ModelSelection>()
const PICKER_TTL_MS = 10 * 60_000
const MODELS_PER_PAGE = 8
let catalogCache: { value: ProviderCatalog; at: number } | undefined
let codexAccountModels: ProviderModel[] | undefined
const resetTimers = new Map<ProviderId, ReturnType<typeof setTimeout>>()

function modelCatalog(): ProviderCatalog {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.value
  let bridgeOutput = ''
  let openCodeModels = new Map<string, ProviderModel>()
  try {
    bridgeOutput = execFileSync(PROVIDER_PROXY_BIN, ['models'], { encoding: 'utf8', timeout: 15_000 })
  } catch (e) {
    log(`provider bridge model catalog failed: ${e}`)
  }
  try {
    const output = execFileSync(OPENCODE_BIN, ['api', 'model.list'], {
      encoding: 'utf8', timeout: 20_000,
    })
    openCodeModels = parseOpenCodeModels(output)
  } catch (e) {
    log(`OpenCode model metadata failed: ${e}`)
  }
  const value = catalogFromBridge(bridgeOutput, codexAccountModels, openCodeModels)
  catalogCache = { value, at: Date.now() }
  return value
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })
}

function currentRoute(st: TopicState): TopicRoute {
  return st.route ?? DEFAULT_TOPIC_ROUTE
}

function routeSummary(route: TopicRoute): string {
  return `${providerLabel(route.provider)} · ${modelLabel(route.model)} · ${route.effort} · ` +
    `Ultracode ${route.ultracode ? 'on' : 'off'}`
}

function auxiliaryModel(route: TopicRoute): string {
  return auxiliaryModelForRoute(
    route,
    modelCatalog()[route.provider]
      .filter(model => model.bridgeSupported !== false)
      .map(model => model.id),
  )
}

function executionPolicySummary(route: TopicRoute): string {
  const effort = route.effort === 'auto' ? 'provider default' : `${route.effort} enforced`
  return [
    `Subagents: ${modelLabel(route.model)} · ${effort}`,
    `Auxiliary: ${modelLabel(auxiliaryModel(route))}`,
    `Workflow: ${route.ultracode ? 'enabled' : 'blocked'}`,
  ].join('\n')
}

function providerKeyboard(topic: string, reason: PickerReason, exclude?: ProviderId): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  const providers: ProviderId[] = ['anthropic', 'codex', 'opencode-go']
  for (const provider of providers.filter(value => value !== exclude)) {
    const availability = capacities.get(provider)?.availability
    const suffix = availability === 'exhausted' ? ' · limit reached' : availability === 'available' ? ' · available' : ''
    keyboard.text(`${providerLabel(provider)}${suffix}`, encodeCallback({ kind: 'provider', provider, reason, topic })).row()
  }
  keyboard.text('Usage', encodeCallback({ kind: 'usage', topic }))
  return keyboard
}

async function sendProviderPicker(
  chatId: string,
  topic: string,
  reason: PickerReason,
  text: string,
  exclude?: ProviderId,
): Promise<void> {
  await bot.api.sendMessage(chatId, text, {
    ...threadOf(topic),
    reply_markup: providerKeyboard(topic, reason, exclude),
  }).catch(e => log(`provider picker failed for topic ${topic}: ${e}`))
}

function modelToken(selection: ModelSelection): string {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  modelSelections.set(token, selection)
  return token
}

function pruneModelSelections(): void {
  const now = Date.now()
  for (const [token, selection] of modelSelections) {
    if (selection.expiresAt < now) modelSelections.delete(token)
  }
}

function modelPicker(
  topic: string,
  provider: ProviderId,
  reason: PickerReason,
  page: number,
): { text: string; keyboard: InlineKeyboard } {
  pruneModelSelections()
  const models = modelCatalog()[provider]
  const pages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE))
  const safePage = Math.max(0, Math.min(page, pages - 1))
  const keyboard = new InlineKeyboard()
  for (const model of models.slice(safePage * MODELS_PER_PAGE, (safePage + 1) * MODELS_PER_PAGE)) {
    const token = modelToken({ topic, provider, model, reason, expiresAt: Date.now() + PICKER_TTL_MS })
    keyboard.text(`${model.label}${model.bridgeSupported === false ? ' · bridge update needed' : ''}`, encodeCallback({ kind: 'model', token })).row()
  }
  if (pages > 1) {
    if (safePage > 0) {
      keyboard.text('Previous', encodeCallback({ kind: 'models', provider, reason, topic, page: safePage - 1 }))
    }
    if (safePage + 1 < pages) {
      keyboard.text('Next', encodeCallback({ kind: 'models', provider, reason, topic, page: safePage + 1 }))
    }
    keyboard.row()
  }
  keyboard.text('Back', encodeCallback({ kind: 'providers', reason, topic }))
  return {
    text: models.length
      ? `${providerLabel(provider)} models${pages > 1 ? ` (${safePage + 1}/${pages})` : ''}:` + permissionNotice(provider)
      : `${providerLabel(provider)} model catalog is temporarily unavailable. Go back and try again.`,
    keyboard,
  }
}

function topicRuntime(topic: string, st: TopicState): 'idle' | 'busy' {
  const live = !!(st.session && mux.liveSessions().has(st.session))
  if (!live) return 'idle'
  if (inboundModeForRoute(currentRoute(st)) === 'pane') {
    if (panePumps.get(topic)?.inFlight) return 'busy'
    return mux.runtime(st.session) === 'idle' ? 'idle' : 'busy'
  }
  if (st.waiters.length > 0) return 'idle'
  return 'busy'
}

function recoveryNotice(from: TopicRoute, to: TopicRoute): string {
  return (
    `SYSTEM NOTICE (not a user message): the previous turn failed because ${providerLabel(from.provider)} ` +
    `${modelLabel(from.model)} reached its usage limit. This same Claude Code session has resumed through ${providerLabel(to.provider)} ` +
    `on ${modelLabel(to.model)}, with the full conversation intact. Continue where you left off and answer ` +
    `the user's most recent unanswered message now. Mention the provider switch only if it affects the answer.`
  )
}

function applyRouteNow(topic: string, route: TopicRoute, reason: RouteChangeReason): void {
  const st = getTopic(topic)
  const from = currentRoute(st)
  killSession(st, topic)
  st.route = route
  st.pendingRoute = undefined
  if (reason === 'quota') {
    const exhausted = st.exhaustedRoutes.at(-1) ?? from
    st.pendingResumeNotice = recoveryNotice(exhausted, route)
  }
  const recorded = exhaustedRouteFor(st.exhaustedRoutes, route.provider)
  if (reason === 'reset' || (recorded && !retainsExhaustedRoute(recorded, route, reason))) {
    st.exhaustedRoutes = forgetExhaustedProvider(st.exhaustedRoutes, route.provider)
  }
  saveRegistry()
  ensureSession(topic)
  schedulePanePump(topic)
  log(`topic ${topic} route applied: ${routeSummary(from)} -> ${routeSummary(route)} (${reason})`)
}

function requestRouteChange(topic: string, route: TopicRoute, reason: RouteChangeReason): 'unchanged' | 'applied' | 'queued' {
  const st = getTopic(topic)
  const plan = planRouteChange(currentRoute(st), route, reason, topicRuntime(topic, st), Date.now())
  if (plan.kind === 'unchanged') return 'unchanged'
  if (plan.kind === 'wait-for-turn-boundary') {
    st.pendingRoute = plan.pending
    if (reason === 'quota') {
      st.pendingResumeNotice = recoveryNotice(st.exhaustedRoutes.at(-1) ?? currentRoute(st), route)
    }
    saveRegistry()
    if (inboundModeForRoute(currentRoute(st)) === 'pane') schedulePanePump(topic, 250)
    return 'queued'
  }
  applyRouteNow(topic, plan.route, plan.reason)
  return 'applied'
}

async function handleModelCommand(chatId: string, topic: string, fromId: string, arg: string): Promise<void> {
  if (SQUARE_TOPIC && topic === SQUARE_TOPIC) {
    await sayIn(chatId, topic, 'The square has no Claude session of its own. Run /model in a topic.')
    return
  }
  if (!ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
    await sayIn(chatId, topic, 'Only the operator can change provider or model routes.')
    return
  }
  const value = arg.trim().toLowerCase()
  if (value === 'status') {
    const st = getTopic(topic)
    const route = currentRoute(st)
    await sayIn(
      chatId,
      topic,
      `Claude session: ${st.claudeSessionId ?? 'not started'}\n` +
      `Route: ${routeSummary(route)}\n${executionPolicySummary(route)}`,
    )
    return
  }
  const requestedProvider = value === 'chatgpt' || value === 'codex'
    ? 'codex'
    : value === 'opencode' || value === 'opencode-go'
      ? 'opencode-go'
      : value === 'anthropic' || value === 'claude'
        ? 'anthropic'
        : undefined
  if (requestedProvider) {
    const picker = modelPicker(topic, requestedProvider, 'manual', 0)
    await bot.api.sendMessage(chatId, picker.text, { ...threadOf(topic), reply_markup: picker.keyboard })
      .catch(noticeFailed('model picker', topic))
    return
  }
  const route = currentRoute(getTopic(topic))
  await sendProviderPicker(chatId, topic, 'manual', `Current route: ${routeSummary(route)}\n\nChoose a provider:`)
}

function capacityText(): string {
  const lines: string[] = []
  for (const provider of ['anthropic', 'codex', 'opencode-go'] as ProviderId[]) {
    const capacity = capacities.get(provider)
    if (!capacity) {
      lines.push(`${providerLabel(provider)}: usage not observed yet`)
      continue
    }
    const windows = capacity.windows.map(window => {
      const used = window.usedPercent == null ? window.availability : `${window.usedPercent}% used`
      return `${window.name}: ${used}${window.resetsAt ? `, resets ${formatTime(window.resetsAt)}` : ''}`
    })
    lines.push(`${providerLabel(provider)}: ${capacity.availability}\n  ${windows.join('\n  ')}`)
    if (capacity.resetCredits) lines.push(`  ${capacity.resetCredits} reset credit(s) available`)
  }
  return `Provider usage\n\n${lines.join('\n\n')}`
}

function switchBackKeyboard(topic: string, route: TopicRoute): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Switch back to ${modelLabel(route.model)}`, encodeCallback({ kind: 'switch-back', provider: route.provider, topic }))
    .row()
    .text(`Choose ${providerLabel(route.provider)} model`, encodeCallback({ kind: 'provider', provider: route.provider, reason: 'reset', topic }))
    .row()
    .text('Dismiss', encodeCallback({ kind: 'dismiss' }))
}

async function applySwitchBackCallback(ctx: any, provider: ProviderId, topic: string): Promise<void> {
  const st = getTopic(topic)
  const route = exhaustedRouteFor(st.exhaustedRoutes, provider)
  if (!route) {
    await ctx.answerCallbackQuery({ text: 'This switch-back was already handled or is no longer available.' }).catch(() => {})
    return
  }
  if (capacities.get(provider)?.availability === 'exhausted') {
    await ctx.answerCallbackQuery({
      text: `${providerLabel(provider)} is still at its usage limit.`,
      show_alert: true,
    }).catch(() => {})
    return
  }
  const since = Date.now() - (lastRouteChange.get(topic) ?? 0)
  if (since < ROUTE_DEBOUNCE_MS) {
    await ctx.answerCallbackQuery({ text: 'A route change just ran. Wait a moment.' }).catch(() => {})
    return
  }
  lastRouteChange.set(topic, Date.now())
  const result = requestRouteChange(topic, route, 'reset')
  if (result === 'unchanged') {
    st.exhaustedRoutes = forgetExhaustedProvider(st.exhaustedRoutes, provider)
    saveRegistry()
  }
  const text = result === 'queued'
    ? `Queued ${routeSummary(route)}. It will switch when the current Claude turn finishes.`
    : result === 'unchanged'
      ? `Already using ${routeSummary(route)}.`
      : `Now using ${routeSummary(route)} in the same Claude session.`
  await ctx.editMessageText(text + permissionNotice(route.provider)).catch((error: unknown) =>
    log(`could not update switch-back message for topic ${topic}: ${error}`))
  await ctx.answerCallbackQuery({ text: result === 'queued' ? 'Switch queued.' : 'Route updated.' }).catch(() => {})
  log(`switch-back callback for topic ${topic}: ${provider}/${route.model} (${result})`)
}

async function notifyProviderReset(provider: ProviderId): Promise<void> {
  for (const [topic, st] of topics) {
    const route = exhaustedRouteFor(st.exhaustedRoutes, provider)
    if (!route) continue
    await bot.api.sendMessage(
      String(GROUP_CHAT_ID),
      `${providerLabel(provider)} is available again. This topic switched away after its limit was reached.`,
      { ...threadOf(topic), reply_markup: switchBackKeyboard(topic, route) },
    ).catch(e => log(`reset notice failed for ${provider} topic ${topic}: ${e}`))
  }
}

function scheduleCapacityReset(capacity: ProviderCapacity): void {
  const existing = resetTimers.get(capacity.provider)
  if (existing) clearTimeout(existing)
  const at = nextResetAt(capacity)
  if (!at || capacity.availability !== 'exhausted') return
  const delay = Math.min(Math.max(1000, at - Date.now() + 1000), 2_147_000_000)
  resetTimers.set(capacity.provider, setTimeout(() => {
    const current = capacities.get(capacity.provider)
    if (!current) return
    const now = Date.now()
    const windows = current.windows.map(window =>
      window.resetsAt && window.resetsAt <= now
        ? { ...window, usedPercent: 0, availability: 'available' as const }
        : window,
    )
    observeCapacity(providerCapacity(capacity.provider, windows, now, current.resetCredits))
  }, delay))
}

function observeCapacity(capacity: ProviderCapacity): void {
  const previous = capacities.get(capacity.provider)
  capacities.set(capacity.provider, capacity)
  scheduleCapacityReset(capacity)
  if (capacityTransition(previous, capacity) === 'reset') void notifyProviderReset(capacity.provider)
}

async function refreshProviderCapacity(): Promise<void> {
  const [codex, opencode] = await Promise.allSettled([
    readCodexSnapshot(),
    readOpenCodeGoCapacity(OPENCODE_GO_KEY_FILE, () =>
      execFileSync(OPENCODE_BIN, ['auth', 'export'], { encoding: 'utf8', timeout: 20_000 })),
  ])
  if (codex.status === 'fulfilled') {
    codexAccountModels = codex.value.models
    catalogCache = undefined
    observeCapacity(codex.value.capacity)
  } else {
    log(`Codex capacity probe failed: ${codex.reason}`)
  }
  if (opencode.status === 'fulfilled') observeCapacity(opencode.value)
  else log(`OpenCode Go capacity probe failed: ${opencode.reason}`)
}

// The "/" menu: discoverable, autocompleted, and free of the "--" a phone
// keyboard mangles. Scoped to the group so no other chat learns the verbs.
// Idempotent, and a failure only costs the menu, never the commands.
async function registerCommands(): Promise<void> {
  const commands = [
    { command: 'relaunch', description: "restart this topic's agent (same conversation, reloads MCP config)" },
    ...(ADMIN_USER_ID
      ? [
          { command: 'antigravity', description: 'lock a fresh topic to the Antigravity harness' },
          { command: 'localcode', description: 'lock a fresh topic to the local OpenCode/Qwen harness' },
          { command: 'localgen', description: 'lock a fresh topic to the local image generator (prompts in, PNGs out)' },
          { command: 'model', description: 'choose this topic\'s provider and model' },
          { command: 'usage', description: 'show usage and reset times for every provider' },
        ]
      : []),
    ...(SECRETS_USER_ID
      ? [
          { command: 'secret', description: 'store a credential: /secret <name>, value on the next line' },
          { command: 'secrets', description: 'list stored credentials (names and sizes only)' },
          { command: 'unsecret', description: 'delete a stored credential: /unsecret <name>' },
        ]
      : []),
  ]
  try {
    await bot.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: Number(GROUP_CHAT_ID) } })
    log(`registered ${commands.map(c => '/' + c.command).join(', ')} in the group command menu`)
  } catch (err) {
    log(`could not register the group commands: ${err}`)
  }
}

bot.on('message', async ctx => {
  const msg = ctx.message
  // Access control: only the configured forum group. Everything else dropped.
  if (String(ctx.chat.id) !== String(GROUP_CHAT_ID)) return

  const topic = msg.message_thread_id != null ? String(msg.message_thread_id) : 'general'
  // One line per inbound message so a topic that never answers can be traced to arrival or to routing.
  if (localgenService.isLocked(topic)) log(`inbound topic ${topic} message ${msg.message_id ?? '(no id)'} text=${typeof msg.text === 'string'} kind=${Object.keys(msg).filter(k => ['text','photo','document','voice','sticker','location','venue','forum_topic_created','forum_topic_edited'].includes(k)).join(',') || 'other'}`)

  // Secret drop runs before every relay path, the square included, so the
  // value can reach neither a topic-Claude nor a peer. See handleSecretDrop.
  if (typeof msg.text === 'string' && SECRET_CMD_RE.test(msg.text)) {
    await handleSecretDrop(String(ctx.chat.id), topic, msg.message_id, String(ctx.from?.id ?? ''), msg.text)
    return
  }
  if (typeof msg.text === 'string' && ANTIGRAVITY_RE.test(msg.text)) {
    await activateAntigravityTopic(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''))
    return
  }
  if (typeof msg.text === 'string' && LOCALCODE_RE.test(msg.text)) {
    await activateLocalcodeTopic(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''))
    return
  }
  const localgenMatch = typeof msg.text === 'string' ? LOCALGEN_RE.exec(msg.text) : null
  if (localgenMatch) {
    await activateLocalgenTopic(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''), localgenMatch[1] ?? '')
    return
  }
  if (typeof msg.text === 'string' && RELAUNCH_RE.test(msg.text)) {
    await handleRelaunch(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''))
    return
  }
  const modelMatch = MODEL_RE.exec(msg.text ?? '')
  if (modelMatch) {
    if (antigravityService.isLocked(topic)) {
      await handleAntigravityModelCommand(
        String(ctx.chat.id), topic, String(ctx.from?.id ?? ''), modelMatch[1] ?? '',
      )
    } else if (opencodeService.isLocked(topic)) {
      await handleOpencodeModelCommand(String(ctx.chat.id), topic, modelMatch[1] ?? '')
    } else if (localgenService.isLocked(topic)) {
      await handleLocalgenModelCommand(String(ctx.chat.id), topic, modelMatch[1] ?? '')
    } else {
      await handleModelCommand(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''), modelMatch[1] ?? '')
    }
    return
  }
  if (USAGE_RE.test(msg.text ?? '')) {
    if (!ADMIN_USER_ID || String(ctx.from?.id ?? '') !== ADMIN_USER_ID) {
      await sayIn(String(ctx.chat.id), topic, 'Only the operator can inspect provider usage.')
    } else if (antigravityService.isLocked(topic)) {
      try {
        await sayIn(String(ctx.chat.id), topic, antigravityUsageText(await refreshAntigravityUsage(true)))
      } catch (error) {
        await sayIn(String(ctx.chat.id), topic, `Could not read Antigravity usage: ${reason(error)}`)
      }
    } else if (opencodeService.isLocked(topic)) {
      await sayIn(String(ctx.chat.id), topic, 'OpenCode runs on the local Qwen server; there is no quota to report.')
    } else if (localgenService.isLocked(topic)) {
      await sayIn(String(ctx.chat.id), topic, 'localgen runs on the local qwen-image server; there is no quota to report.')
    } else {
      await refreshProviderCapacity()
      await sayIn(String(ctx.chat.id), topic, capacityText())
    }
    return
  }
  // A reply to a guided-flow prompt (name or value) belongs to the flow and is
  // never relayed. Checked after the verbs so a fresh /secret restarts cleanly.
  if (typeof msg.text === 'string' && ctx.from) {
    const fromId = String(ctx.from.id)
    const flow = pendingSecretFlow(fromId, topic)
    if (flow) {
      await handleSecretStep(String(ctx.chat.id), topic, msg.message_id, fromId, msg.text, flow)
      return
    }
  }

  // Square-topic USER messages route by conversation membership / @tags -
  // there is no claude "for" the square, so they never hit the normal path.
  // (Service messages fall through to the name-learning handlers below.)
  if (SQUARE_TOPIC && topic === SQUARE_TOPIC && !msg.forum_topic_created && !msg.forum_topic_edited) {
    const text = msg.text ?? msg.caption ?? ''
    if (text) handleSquareUserMessage(msg, String(text))
    return
  }

  // Learn topic names from the creation service message; do not relay it.
  if (msg.forum_topic_created) {
    const nm = msg.forum_topic_created.name
    topicNames.set(topic, nm)
    const st = topics.get(topic)
    if (st && !st.name) st.name = nm
    if (antigravityService.isLocked(topic)) antigravityService.rename(topic, nm)
    if (opencodeService.isLocked(topic)) opencodeService.rename(topic, nm)
    if (localgenService.isLocked(topic)) localgenService.rename(topic, nm)
    log(`learned topic ${topic} name "${nm}"`)
    return
  }

  // A rename (forum_topic_edited carries the new name when the title changed;
  // it is absent for an icon-only edit). Update the learned name + persist it, so
  // the session picks up `claude-<new-slug>-<tid>` on its next respawn (the live
  // session keeps its current name until then). Do not relay the service message.
  if (msg.forum_topic_edited) {
    const nm = msg.forum_topic_edited.name
    if (nm) {
      topicNames.set(topic, nm)
      const st = topics.get(topic)
      if (st) {
        st.name = nm
        saveRegistry()
      }
      if (antigravityService.isLocked(topic)) antigravityService.rename(topic, nm)
      if (opencodeService.isLocked(topic)) opencodeService.rename(topic, nm)
      if (localgenService.isLocked(topic)) localgenService.rename(topic, nm)
      log(`topic ${topic} renamed to "${nm}"`)
    }
    return
  }

  // Permission-reply intercept: a "yes <id>" / "no <id>" text reply to a
  // pending permission request in THIS topic is routed to the permission
  // relay, NOT enqueued as a normal channel turn. The pendingPerms lookup +
  // the topic match guard this: a stray token that is not a live request for
  // this topic falls through and relays as an ordinary message.
  if (typeof msg.text === 'string') {
    const pm = PERMISSION_REPLY_RE.exec(msg.text)
    if (pm) {
      const requestId = pm[2]
      const pending = pendingPerms.get(requestId)
      if (pending && pending.topic === topic) {
        const behavior = pm[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
        resolvePermission(requestId, behavior)
        if (msg.message_id != null) {
          const emoji = behavior === 'allow' ? '✅' : '❌'
          void bot.api
            .setMessageReaction(String(ctx.chat.id), msg.message_id, [
              { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
            ])
            .catch(() => {})
        }
        return
      }
    }
  }

  const desc = describeMessage(msg)
  if (!desc) return // service message with nothing to relay

  // localgen: the text IS the prompt; nothing is downloaded, queued, or spawned.
  if (localgenService.isLocked(topic)) {
    if (typeof msg.text !== 'string') {
      await sayIn(String(ctx.chat.id), topic, 'localgen takes text prompts only.')
      return
    }
    log(`received localgen prompt ${msg.message_id ?? '(no id)'} for topic ${topic}`)
    void localgenService.submit(topic, msg.text)
      .then(() => log(`settled localgen prompt ${msg.message_id ?? '(no id)'} for topic ${topic}`))
      .catch(error => log(`localgen prompt ${msg.message_id ?? '(no id)'} for topic ${topic} threw: ${error}`))
    return
  }

  let imagePath: string | undefined
  if (desc.photo) {
    imagePath = (await downloadFile(desc.photo.file_id, desc.photo.file_unique_id)) ?? undefined
  }

  // Claude topics can lazily call download_attachment through their MCP. The
  // Antigravity and OpenCode harnesses do not load that Claude plugin, so the
  // proxy eagerly materializes non-photo attachments and supplies the safe
  // local path in the channel metadata instead.
  let attachmentPath: string | undefined
  const eagerAttachments = antigravityService.isLocked(topic) || opencodeService.isLocked(topic)
  if (eagerAttachments && desc.attachment && !imagePath) {
    attachmentPath = (await downloadFile(desc.attachment.file_id, desc.attachment.name)) ?? undefined
  }

  let voiceTranscribed = false
  if (desc.attachment?.kind === 'voice') {
    const text = await transcribeVoice(VOICE, downloadFile, desc.attachment.file_id, log)
    if (text) {
      desc.content = (msg.caption ? `${msg.caption}\n\n` : '') + `${VOICE_TAG}\n${text}`
      voiceTranscribed = true
    }
  }

  const from = ctx.from!
  const meta: Record<string, string> = {
    chat_id: String(ctx.chat.id),
    ...(msg.message_id != null ? { message_id: String(msg.message_id) } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date((msg.date ?? 0) * 1000).toISOString(),
    ...(msg.message_thread_id != null ? { message_thread_id: String(msg.message_thread_id) } : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
    ...(voiceTranscribed ? { voice_transcribed: '1' } : {}),
    ...(desc.attachment
      ? {
          attachment_kind: desc.attachment.kind,
          attachment_file_id: desc.attachment.file_id,
          ...(desc.attachment.size != null ? { attachment_size: String(desc.attachment.size) } : {}),
          ...(desc.attachment.mime ? { attachment_mime: desc.attachment.mime } : {}),
          ...(desc.attachment.name ? { attachment_name: desc.attachment.name } : {}),
        }
      : {}),
  }

  if (antigravityService.isLocked(topic)) {
    log(`received Antigravity Telegram turn ${msg.message_id ?? '(no id)'} for topic ${topic}`)
    void antigravityService.submitTurn(topic, { content: desc.content, meta })
      .then(() => log(`settled Antigravity Telegram turn ${msg.message_id ?? '(no id)'} for topic ${topic}`))
    return
  }
  if (opencodeService.isLocked(topic)) {
    log(`received OpenCode Telegram turn ${msg.message_id ?? '(no id)'} for topic ${topic}`)
    void opencodeService.submitTurn(topic, { content: desc.content, meta })
      .then(() => log(`settled OpenCode Telegram turn ${msg.message_id ?? '(no id)'} for topic ${topic}`))
    return
  }

  // Spawn the topic's Claude if none is live, then enqueue. The message waits
  // in the queue until the new MCP's first /poll drains it (nothing is lost
  // during the ~1-2s spawn+register window).
  ensureSession(topic)
  enqueue(topic, { content: desc.content, meta })
})

// Inline-button answers. Route pickers are operator-only and bound to the topic
// and harness that emitted them. A permission answer's access control is the
// group gate: only members of the configured forum group can tap a button that
// lives in that group's thread. Answers and edits here are not logged when they
// fail: Telegram refuses a late answer or an edit that changes nothing routinely.
bot.on('callback_query:data', async ctx => {
  const cb = decodeCallback(ctx.callbackQuery.data ?? '')
  if (!cb) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  if (cb.kind !== 'permission') {
    const cbChatId = ctx.callbackQuery.message?.chat.id
    const fromId = String(ctx.callbackQuery.from.id)
    if (String(cbChatId) !== String(GROUP_CHAT_ID) || !ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }

    const currentTopic = (ctx.callbackQuery.message as any)?.message_thread_id != null
      ? String((ctx.callbackQuery.message as any).message_thread_id)
      : 'general'
    const currentHarness = topicHarnessOf(currentTopic)
    const namedTopic = callbackTopic(cb)
    if (namedTopic && namedTopic !== currentTopic) {
      await ctx.answerCallbackQuery({
        text: 'This control belongs to a different Telegram topic.',
        show_alert: true,
      }).catch(() => {})
      return
    }
    const emitter = callbackHarness(cb)
    if (emitter && emitter !== currentHarness) {
      await ctx.answerCallbackQuery({
        text: currentHarness === 'antigravity'
          ? 'This topic is locked to Google / Antigravity. External provider routes are disabled.'
          : currentHarness === 'opencode'
            ? 'This topic is locked to OpenCode / local Qwen. Model and provider pickers are disabled.'
            : currentHarness === 'localgen'
              ? 'This topic is locked to localgen. Model and provider pickers are disabled.'
              : 'This picker belongs to an Antigravity-locked topic.',
        show_alert: true,
      }).catch(() => {})
      return
    }

    if (cb.kind === 'antigravity-models') {
      const topic = cb.topic
      if (topic !== currentTopic || !antigravityService.isLocked(topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return
      }
      try {
        const picker = await antigravityModelPicker(topic, cb.page)
        await ctx.editMessageText(picker.text, { reply_markup: picker.keyboard })
        await ctx.answerCallbackQuery()
      } catch (error) {
        await ctx.answerCallbackQuery({ text: `Could not load models: ${reason(error)}`, show_alert: true }).catch(() => {})
      }
      return
    }

    if (cb.kind === 'antigravity-model') {
      pruneAntigravitySelections()
      const selection = antigravityModelSelections.get(cb.token)
      if (!selection) {
        await ctx.answerCallbackQuery({ text: 'This model picker expired. Run /model again.' }).catch(() => {})
        return
      }
      if (selection.topic !== currentTopic || !antigravityService.isLocked(selection.topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return
      }
      const keyboard = new InlineKeyboard()
      for (const effort of selection.model.efforts) {
        const suffix = effort === selection.model.defaultEffort ? ' · default' : ''
        keyboard.text(`${effort}${suffix}`, encodeCallback({ kind: 'antigravity-effort', token: cb.token, effort })).row()
      }
      keyboard.text('Back', encodeCallback({ kind: 'antigravity-models', topic: selection.topic, page: 0 }))
      await ctx.editMessageText(`${selection.model.label}: choose reasoning effort`, {
        reply_markup: keyboard,
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (cb.kind === 'antigravity-effort') {
      pruneAntigravitySelections()
      const selection = antigravityModelSelections.get(cb.token)
      const effort = cb.effort
      if (!selection || !selection.model.efforts.includes(effort)) {
        await ctx.answerCallbackQuery({ text: 'This effort picker expired. Run /model again.' }).catch(() => {})
        return
      }
      if (selection.topic !== currentTopic || !antigravityService.isLocked(selection.topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return
      }
      const result = await antigravityService.requestRoute(
        selection.topic,
        antigravityRoute(selection.model, effort),
      )
      const changed = result.topic
      antigravityModelSelections.delete(cb.token)
      await ctx.editMessageText(
        `${result.pending ? 'Switch queued for the next idle boundary:' : 'Now using'} ${antigravityRouteLabel(result.pending ? antigravityRoute(selection.model, effort) : changed.route)} ` +
        `in the same Antigravity conversation (${changed.conversationId ?? 'starts on your first message'}).\n\n` +
        'This topic remains harness-locked; Anthropic, Codex, and OpenCode routes are unavailable here.',
      ).catch(() => {})
      await ctx.answerCallbackQuery({ text: result.pending ? 'Model queued.' : 'Model updated in Herdr.' }).catch(() => {})
      return
    }

    if (cb.kind === 'antigravity-usage') {
      const topic = cb.topic
      if (topic !== currentTopic || !antigravityService.isLocked(topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return
      }
      try {
        const usage = antigravityUsageText(await refreshAntigravityUsage(true))
        await ctx.editMessageText(usage, {
          reply_markup: new InlineKeyboard().text('Back', encodeCallback({ kind: 'antigravity-models', topic, page: 0 })),
        })
        await ctx.answerCallbackQuery()
      } catch (error) {
        await ctx.answerCallbackQuery({ text: `Could not read usage: ${reason(error)}`, show_alert: true }).catch(() => {})
      }
      return
    }

    if (cb.kind === 'switch-back') {
      await applySwitchBackCallback(ctx, cb.provider, cb.topic)
      return
    }

    if (cb.kind === 'provider' || cb.kind === 'models') {
      const { provider, reason, topic } = cb
      const page = cb.kind === 'models' ? cb.page : 0
      if (capacities.get(provider)?.availability === 'exhausted') {
        await ctx.answerCallbackQuery({
          text: `${providerLabel(provider)} is still at its usage limit. Use /usage for the reset time.`,
          show_alert: true,
        }).catch(() => {})
        return
      }
      const picker = modelPicker(topic, provider, reason, page)
      await ctx.editMessageText(picker.text, { reply_markup: picker.keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (cb.kind === 'providers') {
      const { reason, topic } = cb
      const st = getTopic(topic)
      const exclude = reason === 'quota' ? st.exhaustedRoutes.at(-1)?.provider : undefined
      await ctx.editMessageText('Choose a provider:', {
        reply_markup: providerKeyboard(topic, reason, exclude),
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (cb.kind === 'model') {
      pruneModelSelections()
      const selection = modelSelections.get(cb.token)
      if (!selection) {
        const legacy = legacySwitchBack(ctx.callbackQuery.message)
        if (legacy) {
          await applySwitchBackCallback(ctx, legacy.provider, legacy.topic)
          return
        }
        await ctx.answerCallbackQuery({ text: 'This model picker expired. Run /model again.' }).catch(() => {})
        return
      }
      if (capacities.get(selection.provider)?.availability === 'exhausted') {
        await ctx.answerCallbackQuery({
          text: `${providerLabel(selection.provider)} is still at its usage limit.`,
          show_alert: true,
        }).catch(() => {})
        return
      }
      if (selection.model.bridgeSupported === false) {
        await ctx.answerCallbackQuery({
          text: `${selection.model.label} is installed but this bridge build cannot route it yet.`,
          show_alert: true,
        }).catch(() => {})
        return
      }
      const keyboard = new InlineKeyboard()
      for (const effort of selection.model.efforts) {
        const label = effort === 'auto' ? 'Provider default' : effort
        const suffix = effort === selection.model.defaultEffort ? ' · default' : ''
        keyboard.text(`${label}${suffix}`, encodeCallback({ kind: 'effort', token: cb.token, effort })).row()
      }
      await ctx.editMessageText(`${selection.model.label}: choose reasoning effort`, {
        reply_markup: keyboard,
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (cb.kind === 'effort') {
      pruneModelSelections()
      const selection = modelSelections.get(cb.token)
      const effort = cb.effort
      if (!selection || !selection.model.efforts.includes(effort)) {
        await ctx.answerCallbackQuery({ text: 'This effort picker expired.' }).catch(() => {})
        return
      }
      selection.effort = effort
      const keyboard = new InlineKeyboard().text('Off', encodeCallback({ kind: 'ultracode', token: cb.token, on: false })).row()
      if (selection.model.supportsUltracode) {
        keyboard.text('On · forces xhigh + workflows', encodeCallback({ kind: 'ultracode', token: cb.token, on: true })).row()
      }
      const compact = autoCompactWindow(selection.provider, selection.model.contextWindow)
      await ctx.editMessageText(
        `${selection.model.label} · ${effort === 'auto' ? 'provider-default effort' : `${effort} effort`}\n` +
        `Auto-compaction: ${compact ? `${compact.toLocaleString()} tokens` : 'provider-managed'}\n\n` +
        (selection.model.supportsUltracode
          ? 'Choose Ultracode. Turning it on overrides effort to xhigh and enables dynamic workflows.'
          : 'Ultracode is not supported by this model; choose Off.'),
        { reply_markup: keyboard },
      ).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (cb.kind === 'ultracode') {
      pruneModelSelections()
      const selection = modelSelections.get(cb.token)
      const ultracode = cb.on
      if (!selection || !selection.effort) {
        await ctx.answerCallbackQuery({ text: 'This model picker expired. Run /model again.' }).catch(() => {})
        return
      }
      if (ultracode && !selection.model.supportsUltracode) {
        await ctx.answerCallbackQuery({ text: 'Ultracode is not supported by this model.', show_alert: true }).catch(() => {})
        return
      }
      if (capacities.get(selection.provider)?.availability === 'exhausted') {
        await ctx.answerCallbackQuery({
          text: `${providerLabel(selection.provider)} is still at its usage limit.`,
          show_alert: true,
        }).catch(() => {})
        return
      }
      const since = Date.now() - (lastRouteChange.get(selection.topic) ?? 0)
      if (since < ROUTE_DEBOUNCE_MS) {
        await ctx.answerCallbackQuery({ text: 'A route change just ran. Wait a moment.' }).catch(() => {})
        return
      }
      lastRouteChange.set(selection.topic, Date.now())
      const route = topicRoute({
        provider: selection.provider,
        model: selection.model.id,
        effort: selection.effort,
        ultracode,
      })
      const result = requestRouteChange(selection.topic, route, selection.reason)
      modelSelections.delete(cb.token)
      await ctx.editMessageText(
        (result === 'queued'
          ? `Queued ${routeSummary(route)}. It will switch when the current Claude turn finishes.`
          : result === 'unchanged'
            ? `Already using ${routeSummary(route)}.`
            : `Now using ${routeSummary(route)} in the same Claude session.`) +
        permissionNotice(route.provider) +
        (result === 'unchanged' && route.provider === 'codex'
          ? '\nRun /relaunch to apply the launch settings to this existing session.' : ''),
      ).catch(() => {})
      await ctx.answerCallbackQuery({ text: result === 'queued' ? 'Switch queued.' : 'Route updated.' }).catch(() => {})
      return
    }

    if (cb.kind === 'usage') {
      await refreshProviderCapacity()
      await ctx.editMessageText(capacityText(), {
        reply_markup: new InlineKeyboard().text('Back', encodeCallback({ kind: 'providers', reason: 'manual', topic: cb.topic })),
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (cb.kind === 'dismiss') {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
      await ctx.answerCallbackQuery({ text: 'Dismissed.' }).catch(() => {})
      return
    }

    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const cbChatId = ctx.callbackQuery.message?.chat.id
  if (String(cbChatId) !== String(GROUP_CHAT_ID)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const { behavior, requestId } = cb
  const delivered = resolvePermission(requestId, behavior)
  if (!delivered) {
    await ctx.answerCallbackQuery({ text: 'No longer pending.' }).catch(() => {})
    return
  }
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  // Replace the buttons with the outcome so the same request cannot be answered
  // twice and the chat history shows what was chosen.
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

// ---- outbound HTTP (the MCP clients call these) ----------------------------

// Outbound gate: reply/react/edit/download can only target the configured group.
function assertGroup(chatId: unknown): void {
  if (String(chatId) !== String(GROUP_CHAT_ID)) {
    throw new Error(`chat ${chatId} is not the configured group`)
  }
}

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
    return Promise.resolve(json({
      content,
      meta: {
        chat_id: String(GROUP_CHAT_ID),
        user: 'telegram-topics-proxy',
        ts: new Date().toISOString(),
        ...(topic !== 'general' ? { message_thread_id: topic } : {}),
        route_switch: '1',
      },
    }))
  }
  const existing = st.queue.shift()
  if (existing) return Promise.resolve(json(existing))
  return new Promise<Response>(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const wrapped = (m: InboundMsg | null) => {
      clearTimeout(timer)
      resolve(m ? json(m) : new Response(null, { status: 204 }))
    }
    timer = setTimeout(() => {
      const i = st.waiters.indexOf(wrapped)
      if (i >= 0) st.waiters.splice(i, 1)
      resolve(new Response(null, { status: 204 }))
    }, 25000)
    st.waiters.push(wrapped)
  })
}

async function handleSend(req: Request): Promise<Response> {
  const { chatId, topic, text, replyTo, files, markdown } = parseSend(await req.json())
  assertGroup(chatId)
  const threadId = threadIdForTopic(topic)
  const parseMode = markdown ? ('MarkdownV2' as const) : undefined

  for (const f of files) {
    assertSendable(f, STATE_DIR, ENV_FILES)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  const ids: number[] = []
  const chunks = text.length ? chunk(text, MAX_CHUNK_LIMIT) : []
  for (let i = 0; i < chunks.length; i++) {
    const sent = await bot.api.sendMessage(chatId, chunks[i], {
      ...(threadId != null ? { message_thread_id: threadId } : {}),
      ...(replyTo != null && i === 0 ? { reply_parameters: { message_id: replyTo } } : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
    })
    ids.push(sent.message_id)
  }

  for (const f of files) {
    const ext = extname(f).toLowerCase()
    const opts = {
      ...(threadId != null ? { message_thread_id: threadId } : {}),
      ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
    }
    const input = new InputFile(f)
    const sent = PHOTO_EXTS.has(ext)
      ? await bot.api.sendPhoto(chatId, input, opts)
      : await bot.api.sendDocument(chatId, input, opts)
    ids.push(sent.message_id)
  }

  if (antigravityService.isLocked(topic)) {
    log(`sent Antigravity Telegram reply for topic ${topic} (${ids.length} message${ids.length === 1 ? '' : 's'})`)
  } else if (opencodeService.isLocked(topic)) {
    opencodeLastSentAt.set(topic, Date.now())
    log(`sent OpenCode Telegram reply for topic ${topic} (${ids.length} message${ids.length === 1 ? '' : 's'})`)
  }

  return json({ message_ids: ids })
}

async function handleReact(req: Request): Promise<Response> {
  const b = parseReact(await req.json())
  assertGroup(b.chatId)
  await bot.api.setMessageReaction(b.chatId, b.messageId, [
    { type: 'emoji', emoji: b.emoji as ReactionTypeEmoji['emoji'] },
  ])
  return json({ ok: true })
}

async function handleEdit(req: Request): Promise<Response> {
  const b = parseEdit(await req.json())
  assertGroup(b.chatId)
  const parseMode = b.markdown ? ('MarkdownV2' as const) : undefined
  const edited = await bot.api.editMessageText(
    b.chatId,
    b.messageId,
    b.text,
    ...(parseMode ? [{ parse_mode: parseMode }] : []),
  )
  const id = typeof edited === 'object' ? edited.message_id : b.messageId
  return json({ message_id: id })
}

async function handleDownload(req: Request): Promise<Response> {
  const path = await downloadFile(parseDownload(await req.json()).fileId)
  if (!path) throw new Error('download failed (file may have expired)')
  return json({ path })
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
  await bot.api.sendMessage(String(GROUP_CHAT_ID), text, {
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    reply_markup: keyboard,
  })
  return json({ ok: true })
}

// Long-poll for a permission answer for a topic. Mirrors handlePoll: ~25s hold,
// 204 on idle, 200 {request_id, behavior} when the user answers.
function handlePermissionPoll(url: URL): Promise<Response> {
  const topic = url.searchParams.get('topic') ?? 'general'
  const st = getTopic(topic)
  const existing = st.permQueue.shift()
  if (existing) return Promise.resolve(json(existing))
  return new Promise<Response>(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const wrapped = (a: PermAnswer | null) => {
      clearTimeout(timer)
      resolve(a ? json(a) : new Response(null, { status: 204 }))
    }
    timer = setTimeout(() => {
      const i = st.permWaiters.indexOf(wrapped)
      if (i >= 0) st.permWaiters.splice(i, 1)
      resolve(new Response(null, { status: 204 }))
    }, 25000)
    st.permWaiters.push(wrapped)
  })
}

// ---- boot ------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// Single-instance guard. Telegram allows exactly one getUpdates consumer per
// token, and Bun.serve wants exclusive ownership of the port. If a previous
// proxy crashed (SIGKILL, terminal closed) it can survive as an orphan holding
// both, so every restart would 409 on the token and EADDRINUSE on the port.
// SIGTERM any stale holder before we claim either. The 409 retry loop + the
// port-bind retry below cover the brief window while it drains.
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0) // throws if the pid is dead - nothing to replace
    // PID files race with OS PID recycling: verify the holder is actually a
    // proxy process before SIGTERM, so a recycled pid can't aim the kill at
    // an unrelated process.
    const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (cmd.includes('proxy.ts')) {
      log(`replacing stale proxy pid=${stale}`)
      process.kill(stale, 'SIGTERM')
    }
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

loadAndReconcileRegistry()
loadConvs()
for (const [topic, st] of topics) {
  if (
    inboundModeForRoute(currentRoute(st)) === 'pane' &&
    (st.queue.length > 0 || !!st.pendingResumeNotice || !!st.pendingRoute)
  ) {
    schedulePanePump(topic)
  }
}
void refreshProviderCapacity()
void refreshAntigravityUsage(false).catch(() => {})
if (Number.isFinite(CAPACITY_POLL_MS) && CAPACITY_POLL_MS >= 60_000) {
  setInterval(() => void refreshProviderCapacity(), CAPACITY_POLL_MS)
  setInterval(() => void refreshAntigravityUsage(true).catch(() => {}), CAPACITY_POLL_MS)
}

// polling liveness for /health. Set on each (re)start of the poll, cleared if
// polling stops. A monitor can tell "process up but deaf" from this alone.
let pollingSince: number | null = null
let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  try {
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
  } catch {}
  // bot.stop() signals the poll loop to end; the current getUpdates request may
  // take up to its long-poll timeout to return. Force-exit after 2s.
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

async function serveWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      Bun.serve({
        port: PORT,
        hostname: '127.0.0.1', // loopback only; the MCP clients are local
        idleTimeout: 60, // > the ~25s long-poll hold
        async fetch(req) {
          const url = new URL(req.url)
          try {
            if (req.method === 'GET' && url.pathname === ROUTE.poll) return handlePoll(url)
            if (req.method === 'GET' && url.pathname === ROUTE.permissionPoll) {
              return handlePermissionPoll(url)
            }
            if (req.method === 'GET' && url.pathname === ROUTE.health) {
              return json({
                ok: true,
                topics: [...topics.keys()],
                port: PORT,
                polling: pollingSince != null,
                polling_since: pollingSince != null ? new Date(pollingSince).toISOString() : null,
              })
            }
            if (req.method === 'POST' && url.pathname === ROUTE.rateLimit) return await handleRateLimit(req)
            if (req.method === 'POST' && url.pathname === ROUTE.capacity) return await handleCapacity(req)
            if (req.method === 'POST' && url.pathname === ROUTE.turnFailed) return await handleTurnFailed(req)
            if (req.method === 'GET' && url.pathname === ROUTE.topics) return handleTopics()
            if (req.method === 'POST' && url.pathname === ROUTE.topicCreate) return await handleTopicCreate(req)
            if (req.method === 'POST' && url.pathname === ROUTE.squareTag) return await handleSquareTag(req)
            if (req.method === 'POST' && url.pathname === ROUTE.squareReply) return await handleSquareReply(req)
            if (req.method === 'POST' && url.pathname === ROUTE.remind) return await handleRemind(req)
            if (req.method === 'GET' && url.pathname === ROUTE.reminders) return handleListReminders(url)
            if (req.method === 'POST' && url.pathname === ROUTE.reminderCancel) return await handleCancelReminder(req)
            if (req.method === 'POST' && url.pathname === ROUTE.send) return await handleSend(req)
            if (req.method === 'POST' && url.pathname === ROUTE.react) return await handleReact(req)
            if (req.method === 'POST' && url.pathname === ROUTE.edit) return await handleEdit(req)
            if (req.method === 'POST' && url.pathname === ROUTE.download) return await handleDownload(req)
            if (req.method === 'POST' && url.pathname === ROUTE.permissionRequest) {
              return await handlePermissionRequest(req)
            }
            return new Response('not found', { status: 404 })
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
        // The port never freed (a foreign process, not our stale proxy). Exit
        // cleanly so launchd/the supervisor restarts us later rather than
        // lingering alive-but-serverless.
        log(`port ${PORT} still busy after ${attempt} attempts, exiting for a clean restart: ${e}`)
        process.exit(1)
      }
      log(`port ${PORT} busy (attempt ${attempt}, stale proxy draining?), retrying in 500ms: ${e}`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

// Retry polling with backoff on any error. bot.catch only handles throws inside
// update handlers; a rejection of bot.start() itself (ETIMEDOUT/ECONNRESET/DNS
// or a 409 from a not-yet-drained old poller) would otherwise stop polling
// permanently while the HTTP server stays up - i.e. the whole bridge goes deaf
// silently. This loop keeps re-polling so a restart self-heals once the stale
// poller exits.
async function pollWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          // Do NOT reset `attempt` here. grammy fires onStart AFTER getMe +
          // deleteWebhook but BEFORE the getUpdates that raises a 409, so
          // zeroing the counter here would defeat the backoff on every
          // conflict and busy-loop the API. The backoff resets in the catch,
          // and only after a stably-up run (see below).
          pollingSince = Date.now()
          log(
            `polling as @${info.username}; group ${GROUP_CHAT_ID}; spawn dir ${SPAWN_DIR}; ` +
            `marketplace ${MARKETPLACE}; default ultracode off; model ${MODEL || '(account default)'}`,
          )
        },
      })
      return // bot.stop() was called - clean exit from the loop
    } catch (err) {
      if (shuttingDown) return
      // bot.stop() mid-setup rejects with grammy's "Aborted delay" - expected.
      if (err instanceof Error && err.message === 'Aborted delay') return
      // Reset the backoff counter only if polling had been stably up for a
      // while (a genuine long-healthy run that then hit a transient error), so
      // recovery is fast. Under a sustained 409 (a stale poller / the other
      // bridge holding the token), polling never gets stably up, so `attempt`
      // keeps climbing to the give-up threshold instead of resetting each cycle.
      const wasStablyUp = pollingSince != null && Date.now() - pollingSince > 30_000
      pollingSince = null
      if (wasStablyUp) attempt = 1
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        log(
          `409 Conflict persists after ${attempt} attempts - another poller is holding ` +
            `the bot token (stray proxy or a second session). Polling gives up; /health will report polling=false.`,
        )
        return
      }
      const delay = Math.min(1000 * attempt, 15000)
      const detail = is409 ? `409 Conflict (another poller holding the token)` : `polling error: ${err}`
      log(`${detail}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

await serveWithRetry()
void pollWithRetry()
void registerCommands()
setInterval(() => void antigravityService.reconcilePending(), 2_000).unref()
setInterval(() => void opencodeService.reconcilePending(), 2_000).unref()
// Overdue reminders (the proxy was down at their time) fire at boot, flagged late.
void fireDueReminders()
setInterval(() => void fireDueReminders(), 15_000).unref()

// ---- Claude Code update restarts --------------------------------------------
//
// Claude Code updates itself, but a running session keeps the binary it started
// with. Once a minute, a topic whose live Claude is older than the installed
// one moves over at a turn boundary (domain/claude-update.ts): an idle one is
// stopped and resumes on its next message; one that is mid-turn, running
// background tasks, or waiting on the operator is left alone until it goes
// idle, then restarted and resumed at once with a one-line notice. Background
// processes left running for over an hour do not hold a topic back. Process
// records come from Claude Code itself, so this needs no multiplexer query.
const UPDATE_RESTART = environmentFlag(process.env.TELEGRAM_TOPICS_UPDATE_RESTART, true, value =>
  log(`TELEGRAM_TOPICS_UPDATE_RESTART="${value}" is not on/off; using on`),
)
const updateDeferred = new Set<string>()
const updateAttempted = new Map<string, string>()

function proxyHoldsWork(topic: string, st: TopicState): boolean {
  if (st.queue.length > 0 || panePumps.get(topic)?.inFlight) return true
  for (const pending of pendingPerms.values()) if (pending.topic === topic) return true
  return false
}

function claudeUpdateSweep(): void {
  const installed = installedClaudeVersion()
  if (!installed) return
  const sessions = liveClaudeSessions()
  for (const [topic, st] of topics) {
    if (SQUARE_TOPIC && topic === SQUARE_TOPIC) continue
    if (harnessLocked(topic) || st.spawning || !st.session || !st.claudeSessionId) continue
    const claude = sessions.get(st.claudeSessionId)
    const action = updateRestartAction({
      running: claude?.version,
      installed,
      activity: claude?.activity,
      activitySince: claude?.activitySince,
      now: Date.now(),
      proxyBusy: proxyHoldsWork(topic, st),
      deferred: updateDeferred.has(topic),
      attempted: updateAttempted.get(topic) === installed,
    })
    if (action === 'none') {
      updateDeferred.delete(topic)
      continue
    }
    if (action === 'wait') {
      if (!updateDeferred.has(topic)) {
        log(`update: topic ${topic} "${st.name}" runs claude ${claude?.version} (${claude?.activity}); restarting onto ${installed} once idle`)
      }
      updateDeferred.add(topic)
      continue
    }
    updateDeferred.delete(topic)
    updateAttempted.set(topic, installed)
    killSession(st, topic)
    if (action === 'restart') {
      ensureSession(topic)
      void sayIn(
        String(GROUP_CHAT_ID),
        topic,
        `♻️ updated to Claude Code ${installed}: same conversation, resumed on the new version.`,
      )
    }
    saveRegistry()
    log(
      `update: topic ${topic} "${st.name}" ${action === 'restart' ? 'restarted and resumed' : 'stopped; resumes on its next message'} ` +
      `(claude ${claude?.version} -> ${installed})`,
    )
  }
}

if (UPDATE_RESTART) {
  setInterval(claudeUpdateSweep, 60_000).unref()
  log('update restarts enabled: live topics move to a newly installed Claude Code at their next idle turn boundary')
}
