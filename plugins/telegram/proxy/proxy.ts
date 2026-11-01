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

import { mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { Bot } from 'grammy'
import { lockRefusal } from './harness/domain/topic-harness'
import type { LockedHarness, TopicHarness } from './harness/domain/topic-harness'
import {
  ADMIN_USER_ID,
  ASK_IMAGES,
  ASK_PORT,
  ASK_TOKEN_FILE,
  ASK_TOPIC,
  ASK_TOPIC_FILE,
  BOT_API_ROOT,
  CAPACITY_POLL_MS,
  CONDUCTOR_DIR,
  CONDUCTOR_LISTEN,
  CONDUCTOR_APNS,
  CONDUCTOR_NODES,
  CONDUCTOR_OPERATOR_LOGIN,
  GROUP_CHAT_ID,
  HC_BIN,
  HC_SESSION,
  HC_TOPICS,
  INBOX_DIR,
  PID_FILE,
  PLUGIN_ROOT,
  SENT_MESSAGES_FILE,
  SQUARE_TOPIC,
  STATE_DIR,
  TAILSCALE_BIN,
  TOKEN,
  UPDATE_RESTART,
  UPDATE_SWEEP_MS,
  VOICE,
} from './config'
import { log, noticeFailed, reason } from './log'
import { mirroredChat, recordingOperatorTurns } from './conductor/mirror'
import { ConductorStore } from './conductor/sqlite-store'
import { listenMode, startConductor } from './conductor/conductor'
import { Ledger } from './conductor/ledger'
import { tailscaleCli } from './conductor/tailscale'
import { conductorControl } from './conductor/control'
import { conductorScreen, conductorTopics } from './conductor/topic-source'
import type { HcTopics } from './conductor/topic-source'
import { watchHc } from './conductor/hc-watch'
import { hcEnvironment, hcSocketPath } from './topics/hc-mux'
import { appDelivery } from './conductor/app-delivery'
import { startConfiguredPush } from './conductor/push-service'
import type { MessageKind } from './conductor/domain/message'
import type { TopicHarnessAdapter } from './harness/topic-harness-adapter'
import { createLocalgenHarness } from './harness/localgen/localgen-harness'
import { createOpencodeHarness } from './harness/opencode/opencode-harness'
import { createAntigravityHarness } from './harness/antigravity/antigravity-harness'
import { createRouting } from './routing/routing'
import { createFullDiskAccessWatch, hcFullDiskAccessProbe } from './topics/hc-full-disk-access'
import { createTopicLifecycle } from './topics/lifecycle'
import { createUpdateRestarts } from './topics/update-restarts'
import { createInboundRouter, registerCommands } from './chat/inbound-router'
import { createHttpServer } from './http/server'
import { createOutbound } from './http/outbound'
import { createTelegramInbound } from './telegram/telegram-inbound'
import { claimPidFile, releasePidFile } from './shared/pid-file'
import { createReminders } from './reminders/reminders'
import { createSecretDrop } from './secrets/secret-drop'
import { loadAndReconcileRegistry } from './topics/registry'
import { currentRoute, getTopic } from './topics/state'
import { loadConvs } from './square/conversations'
import { createSquare } from './square/square'
import { telegramDownloader, writeInboxFile } from './telegram/telegram-files'
import { createTelegramChat } from './telegram/telegram-chat'
import { transcribeAudio } from './telegram/voice-transcription'
import { createAsk } from './ask/ask-service'
import { askTarget } from './ask/domain/ask'
import { JsonAskTopicStore } from './ask/json-ask-topic-store'
import { createAskServer } from './http/ask-server'
import { createTopicCreation } from './topics/topic-creation'
import { JsonSentMessages } from './sent/json-sent-messages'
import { openOrSetAside } from './shared/state-file'
import { randomUUID } from 'crypto'

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
const downloadFile = telegramDownloader(bot.api, TOKEN, INBOX_DIR, log, BOT_API_ROOT)
const telegramChat = createTelegramChat(bot.api, String(GROUP_CHAT_ID), downloadFile)
// With the conductor on, every message a topic sees is also kept in its store; the
// chat each service gets says who that service's messages are from.
const conductorStore = CONDUCTOR_LISTEN ? new ConductorStore(CONDUCTOR_DIR) : undefined
const storeFailed = (error: unknown) => log(`conductor store: ${reason(error)}`)
const chatFor = (author: 'agent' | 'proxy', kind: MessageKind = null) =>
  conductorStore ? mirroredChat(telegramChat, conductorStore, { author, kind }, storeFailed) : telegramChat
const chat = chatFor('proxy')
const {
  enqueue,
  killSession,
  ensureSession,
  schedulePanePump,
  paneInFlight,
  resumePendingPanes,
  relaunch,
  interrupt,
} = createTopicLifecycle({
  chat,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  harnessLocked,
  modelCatalog: () => modelCatalog(),
  turnEnded: topic => turnEnded(topic),
  noticeDelivered: topic => noticeDelivered(topic),
  hcLaunched: () => hcFullDiskAccess?.check(),
})
const { topicDirectory, slugForTopic, handleSquareTag, handleSquareReply, handleSquareUserMessage } = createSquare({
  chat,
  harnessLocked,
  ensureSession,
  enqueue,
})
const { handleRemind, handleListReminders, handleCancelReminder, fireDueReminders } = createReminders({
  chat: chatFor('proxy', 'reminder'),
  topicDirectory,
  harnessLocked,
  ensureSession,
  enqueue,
})
const secrets = createSecretDrop({
  chat,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  harnessLocked,
  ensureSession,
  enqueue,
})

// Antigravity is a separate harness-bounded context. It shares only the one
// Telegram Bot API adapter with Claude topics; its session identity, model
// catalog, route, and persistence are deliberately separate.
const antigravity = createAntigravityHarness({
  chat,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  mayLockTopic,
})
const antigravityHarness = antigravity.harness

// OpenCode (localcode) is a third harness-bounded context: one local Qwen
// model, no route or usage, persisted in its own file. It shares only the
// Telegram Bot API adapter with the other two.
const opencodeHarness = createOpencodeHarness({
  chat,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  mayLockTopic,
})

// localgen is a fourth harness-bounded context with no agent at all: every
// text message is an image prompt POSTed to the qwen-image server and the PNG
// comes back into the same thread.
const localgenHarness = createLocalgenHarness({
  chat,
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
  turnEnded,
  noticeDelivered,
  routeTopic,
  handleModelCommand,
  capacityText,
  refreshProviderCapacity,
  handleRateLimit,
  handleCapacity,
  handleTurnFailed,
  handleRouteAction,
  requestRoute,
  routeChangeText,
  capacitySnapshot,
} = createRouting({
  chat,
  sayIn: (chatId, topic, text) => sayIn(chatId, topic, text),
  killSession,
  ensureSession,
  schedulePanePump,
  paneInFlight,
})

const sayIn = (_chatId: string, topic: string, t: string) =>
  chat.send(topic, { text: t }).catch(noticeFailed('notice', topic))

// The hc core's Full Disk Access is pinned to its binary, so an hc update loses
// it; the operator hears in general when a probe finds it lost or back.
const hcFullDiskAccess = HC_TOPICS.size
  ? createFullDiskAccessWatch({
      probe: hcFullDiskAccessProbe(HC_BIN, HC_SESSION),
      notify: text => void sayIn('', 'general', text),
      log,
      session: HC_SESSION,
      binary: () => {
        try {
          return realpathSync(HC_BIN)
        } catch {
          return HC_BIN
        }
      },
    })
  : undefined

// ---- harness registry --------------------------------------------------------
//
// Each harness that owns a topic instead of a Claude pane answers that topic's
// commands and messages through one adapter; a topic none owns is a Claude topic.

const HARNESSES: readonly TopicHarnessAdapter[] = [antigravityHarness, opencodeHarness, localgenHarness]
const harnessFor = (topic: string) => HARNESSES.find(h => h.owns(topic))
const harnessOfKind = (kind: LockedHarness) => HARNESSES.find(h => h.kind === kind) as TopicHarnessAdapter
const createTopic = createTopicCreation({ chat, harnessOfKind })
const sentMessages = openOrSetAside('sent messages', SENT_MESSAGES_FILE, () => new JsonSentMessages(SENT_MESSAGES_FILE), log)

// Asks from the phone land in one topic: a configured one, or a dedicated one created on first use.
const askTopicStore = openOrSetAside('ask', ASK_TOPIC_FILE, () => new JsonAskTopicStore(ASK_TOPIC_FILE), log)
const target = askTarget(ASK_TOPIC)
if (!target) log(`TELEGRAM_ASK_TOPIC="${ASK_TOPIC}" is neither a thread id nor "general"; asks are refused`)
const ask = createAsk({
  chat: chatFor('proxy', 'ask'),
  chatId: String(GROUP_CHAT_ID),
  target,
  store: askTopicStore,
  createTopic: name => createTopic(name, 'claude'),
  routeTopic,
  refusal: topic =>
    SQUARE_TOPIC && topic === SQUARE_TOPIC
      ? 'the square cannot take asks'
      : harnessLocked(topic)
        ? `topic ${topic} is locked to another harness`
        : undefined,
  ensureSession,
  enqueue,
  saveImage: (bytes, kind) => writeInboxFile(INBOX_DIR, bytes, kind, `ask-${randomUUID().slice(0, 8)}`),
  transcribe: audio => transcribeAudio(VOICE, INBOX_DIR, audio, log),
  log,
})

const inbound = createTelegramInbound(bot, String(GROUP_CHAT_ID), ADMIN_USER_ID)
inbound.listen(createInboundRouter({
  chat,
  harnesses: HARNESSES,
  harnessFor,
  topicHarnessOf,
  sayIn,
  lifecycle: {
    enqueue: conductorStore ? recordingOperatorTurns(enqueue, conductorStore, ADMIN_USER_ID, storeFailed) : enqueue,
    ensureSession,
    relaunch,
  },
  routing: { handleModelCommand, refreshProviderCapacity, capacityText, handleRouteAction },
  secrets,
  square: { handleSquareUserMessage },
  harnessAction: press => antigravity.handleAction(press),
}))

// ---- boot ------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

claimPidFile(PID_FILE)

loadAndReconcileRegistry()
loadConvs()
resumePendingPanes()
void refreshProviderCapacity()
void antigravity.refreshUsage(false).catch(() => {})
// The conductor's listener, when CONDUCTOR_LISTEN asks for one (docs/conductor.md).
const conductorMode = CONDUCTOR_LISTEN ? listenMode(CONDUCTOR_LISTEN) : undefined
if (CONDUCTOR_LISTEN && !conductorMode) log(`CONDUCTOR_LISTEN="${CONDUCTOR_LISTEN}" is neither store-only nor tailnet:<port>; no listener`)
// hc topics' live states and screens, from one subscription to their core.
const hcTopics: HcTopics | undefined = conductorStore && conductorMode?.listener && HC_TOPICS.size
  ? { topics: HC_TOPICS, watch: watchHc({ socket: hcSocketPath(hcEnvironment(process.env, HC_SESSION)), log }) }
  : undefined
const conductorTopicList = () => conductorTopics(topic => topic === SQUARE_TOPIC, topicHarnessOf, hcTopics)
const conductor = conductorStore && conductorMode?.listener
  ? startConductor({
      mode: conductorMode,
      dir: CONDUCTOR_DIR,
      operatorLogin: CONDUCTOR_OPERATOR_LOGIN,
      allowedNodes: CONDUCTOR_NODES,
      tailnet: tailscaleCli(TAILSCALE_BIN, log),
      ports: {
        store: conductorStore,
        ledger: new Ledger(join(CONDUCTOR_DIR, 'ledger.jsonl')),
        topics: () => conductorTopicList(),
        notify: text => void sayIn('', 'general', text),
        deliver: appDelivery({
          operatorId: ADMIN_USER_ID,
          chatId: String(GROUP_CHAT_ID),
          refuses: topic =>
            SQUARE_TOPIC && topic === SQUARE_TOPIC
              ? 'the square takes no messages from the app'
              : harnessLocked(topic) ? 'this topic is locked to another harness; send from Telegram' : undefined,
          saveImage: (bytes, extension) => writeInboxFile(INBOX_DIR, bytes, extension, `app-${randomUUID().slice(0, 8)}`),
          ensureSession,
          enqueue,
          // Unmirrored: the store already holds the operator's message.
          echo: async (topic, text) => (await telegramChat.send(topic, { text }))[0],
        }),
        control: conductorControl({
          catalog: () => modelCatalog(),
          capacities: () => capacitySnapshot(),
          refreshCapacity: () => refreshProviderCapacity(),
          usageText: () => capacityText(),
          ultracode: topic => currentRoute(getTopic(topic)).ultracode,
          requestRoute: (topic, choice) => requestRoute(topic, choice, 'manual'),
          routeChangeText: request => routeChangeText(request.outcome, request.route),
          noAgent: topic => (SQUARE_TOPIC && topic === SQUARE_TOPIC ? 'the square has no agent of its own' : undefined),
          locked: topic => (harnessLocked(topic) ? 'this topic is locked to another harness; use Telegram' : undefined),
          relaunch: async topic => {
            const harness = harnessFor(topic)
            if (harness) await harness.relaunch({ chatId: String(GROUP_CHAT_ID), topic, fromId: ADMIN_USER_ID })
            else await relaunch(String(GROUP_CHAT_ID), topic, ADMIN_USER_ID)
          },
          interrupt,
          // Unmirrored, like the app's own messages: the app already shows what it did.
          say: async (topic, text) => void (await telegramChat.send(topic, { text }).catch(noticeFailed('app command echo', topic))),
        }),
        ...(hcTopics && {
          screen: (topic: string) => conductorScreen(topic, hcTopics),
          watchTopics: (changed: () => void) => hcTopics.watch.onChange(changed),
        }),
        log,
        version: '1',
      },
    })
  : undefined
if (!conductor) hcTopics?.watch.stop()
const conductorPush = conductor && conductorStore
  ? startConfiguredPush(CONDUCTOR_APNS, { store: conductorStore, topics: conductorTopicList, log })
  : undefined
if (hcFullDiskAccess) {
  hcFullDiskAccess.check()
  setInterval(() => hcFullDiskAccess.check(), 3_600_000)
}
if (Number.isFinite(CAPACITY_POLL_MS) && CAPACITY_POLL_MS >= 60_000) {
  setInterval(() => void refreshProviderCapacity(), CAPACITY_POLL_MS)
  setInterval(() => void antigravity.refreshUsage(true).catch(() => {}), CAPACITY_POLL_MS)
}

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  conductorPush?.stop()
  conductor?.stop()
  hcTopics?.watch.stop()
  releasePidFile(PID_FILE)
  // Force-exit if the current getUpdates outlasts 2s.
  setTimeout(() => process.exit(0), 2000)
  void inbound.stop().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

const http = createHttpServer({
  chat,
  outbound: createOutbound({
    chat: chatFor('agent'),
    sent: reply => {
      sentMessages.record(reply.topic, reply.ids)
      harnessFor(reply.topic)?.sent(reply.topic, reply.ids.length)
      ask.replied(reply.topic, reply.replyTo, reply.text)
    },
    sentMessages,
  }),
  createTopic,
  schedulePanePump,
  turnEnded,
  noticeDelivered,
  routing: { handleRateLimit, handleCapacity, handleTurnFailed },
  square: { topicDirectory, slugForTopic, handleSquareTag, handleSquareReply },
  reminders: { handleRemind, handleListReminders, handleCancelReminder },
  pollingSince: inbound.since,
})
await http.serve()
void createAskServer({ port: ASK_PORT, tokenFile: ASK_TOKEN_FILE, images: ASK_IMAGES, ask: ask.ask, log }).serve()
void inbound.start()
void registerCommands(chat)
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
