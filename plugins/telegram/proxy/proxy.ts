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

import { mkdirSync } from 'fs'
import { join } from 'path'
import { Bot } from 'grammy'
import { lockRefusal } from './harness/domain/topic-harness'
import type { LockedHarness, TopicHarness } from './harness/domain/topic-harness'
import {
  ADMIN_USER_ID,
  BOT_API_ROOT,
  CAPACITY_POLL_MS,
  GROUP_CHAT_ID,
  INBOX_DIR,
  PID_FILE,
  PLUGIN_ROOT,
  SQUARE_TOPIC,
  STATE_DIR,
  TOKEN,
  UPDATE_RESTART,
  UPDATE_SWEEP_MS,
} from './config'
import { log, noticeFailed } from './log'
import type { TopicHarnessAdapter } from './harness/topic-harness-adapter'
import { createLocalgenHarness } from './harness/localgen/localgen-harness'
import { createOpencodeHarness } from './harness/opencode/opencode-harness'
import { createAntigravityHarness } from './harness/antigravity/antigravity-harness'
import { createRouting } from './routing/routing'
import { createTopicLifecycle } from './topics/lifecycle'
import { createUpdateRestarts } from './topics/update-restarts'
import { registerCommands, registerInbound } from './telegram/inbound'
import { createHttpServer } from './http/server'
import { createOutbound } from './http/outbound'
import { createPolling } from './telegram/polling'
import { claimPidFile, releasePidFile } from './shared/pid-file'
import { createReminders } from './reminders/reminders'
import { createSecretDrop } from './secrets/secret-drop'
import { loadAndReconcileRegistry } from './topics/registry'
import { getTopic } from './topics/state'
import { loadConvs } from './square/conversations'
import { createSquare } from './square/square'
import { threadOf } from './telegram/telegram-messages'
import { telegramDownloader } from './telegram/telegram-files'

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

// ---- grammy inbound --------------------------------------------------------

const bot = new Bot(TOKEN, BOT_API_ROOT ? { client: { apiRoot: BOT_API_ROOT } } : undefined)
const downloadFile = telegramDownloader(bot.api, TOKEN, INBOX_DIR, log)
const {
  enqueue,
  killSession,
  ensureSession,
  schedulePanePump,
  paneInFlight,
  resumePendingPanes,
  relaunch,
} = createTopicLifecycle({
  api: bot.api,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  harnessLocked,
  modelCatalog: () => modelCatalog(),
  applyRouteNow: (topic, route, why) => applyRouteNow(topic, route, why),
})
const { topicDirectory, slugForTopic, handleSquareTag, handleSquareReply, handleSquareUserMessage } = createSquare({
  api: bot.api,
  harnessLocked,
  ensureSession,
  enqueue,
})
const { handleRemind, handleListReminders, handleCancelReminder, fireDueReminders } = createReminders({
  api: bot.api,
  topicDirectory,
  harnessLocked,
  ensureSession,
  enqueue,
})
const secrets = createSecretDrop({
  api: bot.api,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  harnessLocked,
  ensureSession,
  enqueue,
})

// Antigravity is a separate harness-bounded context. It shares only the one
// Telegram Bot API adapter with Claude topics; its session identity, model
// catalog, route, and persistence are deliberately separate.
const antigravity = createAntigravityHarness({
  api: bot.api,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  mayLockTopic,
})
const antigravityHarness = antigravity.harness

// OpenCode (localcode) is a third harness-bounded context: one local Qwen
// model, no route or usage, persisted in its own file. It shares only the
// Telegram Bot API adapter with the other two.
const opencodeHarness = createOpencodeHarness({
  api: bot.api,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  mayLockTopic,
})

// localgen is a fourth harness-bounded context with no agent at all: every
// text message is an image prompt POSTed to the qwen-image server and the PNG
// comes back into the same thread.
const localgenHarness = createLocalgenHarness({
  api: bot.api,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  mayLockTopic,
})

function topicHarnessOf(topic: string): TopicHarness {
  return harnessFor(topic)?.kind ?? 'claude'
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
    ownsClaudeConversation: !!claude.claudeSessionId || claude.agent.state === 'running',
  })
  if (refusal) await sayIn(chatId, topic, refusal)
  return !refusal
}

const {
  modelCatalog,
  applyRouteNow,
  handleModelCommand,
  capacityText,
  refreshProviderCapacity,
  handleRateLimit,
  handleCapacity,
  handleTurnFailed,
  handleRouteCallback,
} = createRouting({
  api: bot.api,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  killSession,
  ensureSession,
  schedulePanePump,
  paneInFlight,
})

const sayIn = (chatId: string, topic: string, t: string) =>
  bot.api.sendMessage(chatId, t, threadOf(topic)).catch(noticeFailed('notice', topic))

// ---- harness registry --------------------------------------------------------
//
// Each harness that owns a topic instead of a Claude pane answers that topic's
// commands and messages through one adapter; a topic none owns is a Claude topic.

const HARNESSES: readonly TopicHarnessAdapter[] = [antigravityHarness, opencodeHarness, localgenHarness]
const harnessFor = (topic: string) => HARNESSES.find(h => h.owns(topic))
const harnessOfKind = (kind: LockedHarness) => HARNESSES.find(h => h.kind === kind) as TopicHarnessAdapter

registerInbound(bot, {
  harnesses: HARNESSES,
  harnessFor,
  topicHarnessOf,
  sayIn,
  downloadFile,
  lifecycle: { enqueue, ensureSession, relaunch },
  routing: { handleModelCommand, refreshProviderCapacity, capacityText, handleRouteCallback },
  secrets,
  square: { handleSquareUserMessage },
  harnessCallback: (ctx, cb, topic) => antigravity.handleCallback(ctx, cb, topic),
})

// ---- boot ------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

claimPidFile(PID_FILE)

loadAndReconcileRegistry()
loadConvs()
resumePendingPanes()
void refreshProviderCapacity()
void antigravity.refreshUsage(false).catch(() => {})
if (Number.isFinite(CAPACITY_POLL_MS) && CAPACITY_POLL_MS >= 60_000) {
  setInterval(() => void refreshProviderCapacity(), CAPACITY_POLL_MS)
  setInterval(() => void antigravity.refreshUsage(true).catch(() => {}), CAPACITY_POLL_MS)
}

const polling = createPolling(bot)
let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  releasePidFile(PID_FILE)
  // Force-exit if the current getUpdates outlasts 2s.
  setTimeout(() => process.exit(0), 2000)
  void polling.stop().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

const http = createHttpServer({
  api: bot.api,
  outbound: createOutbound({ api: bot.api, downloadFile, sent: (topic, n) => harnessFor(topic)?.sent(topic, n) }),
  harnessOfKind,
  schedulePanePump,
  applyRouteNow,
  routing: { handleRateLimit, handleCapacity, handleTurnFailed },
  square: { topicDirectory, slugForTopic, handleSquareTag, handleSquareReply },
  reminders: { handleRemind, handleListReminders, handleCancelReminder },
  pollingSince: polling.since,
})
await http.serve()
void polling.run()
void registerCommands(bot.api)
for (const harness of HARNESSES) {
  if (harness.reconcile) setInterval(() => void harness.reconcile?.(), 2_000).unref()
}
// Overdue reminders (the proxy was down at their time) fire at boot, flagged late.
void fireDueReminders()
setInterval(() => void fireDueReminders(), 15_000).unref()

if (UPDATE_RESTART) {
  const { sweep } = createUpdateRestarts({
    sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
    harnessLocked,
    killSession,
    ensureSession,
    paneInFlight,
  })
  setInterval(sweep, UPDATE_SWEEP_MS).unref()
  log('update restarts enabled: live topics move to a newly installed Claude Code at their next idle turn boundary')
}
