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
  rmSync,
  statSync,
} from 'fs'
import { join, extname } from 'path'
import { execFileSync } from 'child_process'
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { SECRET_CMD_RE } from './secrets/secret'
import {
  callbackHarness,
  callbackTopic,
  decodeCallback,
  encodeCallback,
} from './telegram/telegram-callback'
import { inboundModeForRoute } from './shared/domain/inbound-delivery'
import { lockRefusal } from './harness/domain/topic-harness'
import { ROUTE } from './http/routes'
import {
  BadRequest,
  parseDownload,
  parseEdit,
  parsePermissionRequest,
  parseReact,
  parseSend,
  parseTopicCreate,
} from './http/requests'
import { topicSlug } from './shared/domain/topic-slug'
import type { LockedHarness, TopicHarness } from './harness/domain/topic-harness'
import {
  ADMIN_USER_ID,
  BOT_API_ROOT,
  CAPACITY_POLL_MS,
  ENV_FILES,
  GROUP_CHAT_ID,
  INBOX_DIR,
  MARKETPLACE,
  MODEL,
  PID_FILE,
  PLUGIN_ROOT,
  PORT,
  PROXY_URL,
  SECRETS_USER_ID,
  SPAWN_DIR,
  SQUARE_TOPIC,
  STATE_DIR,
  TOKEN,
  UPDATE_RESTART,
  UPDATE_SWEEP_MS,
  VOICE,
} from './config'
import { log, noticeFailed } from './log'
import type { TopicContext, TopicHarnessAdapter } from './harness/topic-harness-adapter'
import { createLocalgenHarness } from './harness/localgen/localgen-harness'
import { createOpencodeHarness } from './harness/opencode/opencode-harness'
import { createAntigravityHarness } from './harness/antigravity/antigravity-harness'
import { createRouting } from './routing/routing'
import { createTopicLifecycle, resumeNoticeTurn } from './topics/lifecycle'
import { createUpdateRestarts } from './topics/update-restarts'
import { createReminders } from './reminders/reminders'
import { createSecretDrop } from './secrets/secret-drop'
import { PERMISSION_REPLY_RE, pendingPerms, prunePendingPerms, resolvePermission } from './topics/permissions'
import { loadAndReconcileRegistry, saveRegistry } from './topics/registry'
import { currentRoute, getTopic, topicNames, topics } from './topics/state'
import type { InboundMsg, PermAnswer } from './topics/state'
import { loadConvs } from './square/conversations'
import { createSquare } from './square/square'
import { json } from './http/response'
import {
  assertSendable,
  chunk,
  threadIdForTopic,
  threadOf,
  describeMessage,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_LIMIT,
  PHOTO_EXTS,
} from './telegram/telegram-messages'
import { telegramDownloader } from './telegram/telegram-files'
import { transcribeVoice, VOICE_TAG } from './telegram/voice-transcription'

// "/relaunch" in a topic kills that topic's agent and respawns it with the
// same provider route and conversation, freshly loading MCP servers and settings
// that a running session cannot pick up mid-flight.
const RELAUNCH_RE = /^\/relaunch(?:@\w+)?\s*$/

const MODEL_RE = /^\/model(?:@\w+)?(?:\s+(\S+))?\s*$/
const USAGE_RE = /^\/usage(?:@\w+)?\s*$/

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
  const lockNewTopic = harness === 'claude' ? undefined : await harnessOfKind(harness).prepareTopic(name)
  const created = await bot.api.createForumTopic(String(GROUP_CHAT_ID), name)
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
    slug: harness === 'claude' ? slugForTopic(topic) : topicSlug(name),
  })
}

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
const { handleSecretDrop, pendingSecretFlow, handleSecretStep } = createSecretDrop({
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
    ownsClaudeConversation: !!(claude.claudeSessionId || claude.session),
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

bot.catch(err => {
  process.stderr.write(`telegram-topics-proxy: handler error (polling continues): ${err.error}\n`)
})


async function handleRelaunch(chatId: string, topic: string, fromId: string): Promise<void> {
  const harness = harnessFor(topic)
  if (harness) await harness.relaunch({ chatId, topic, fromId })
  else await relaunch(chatId, topic, fromId)
}

// ---- harness registry --------------------------------------------------------
//
// Each harness that owns a topic instead of a Claude pane answers that topic's
// commands and messages through one adapter; a topic none owns is a Claude topic.

const HARNESSES: readonly TopicHarnessAdapter[] = [antigravityHarness, opencodeHarness, localgenHarness]
const harnessFor = (topic: string) => HARNESSES.find(h => h.owns(topic))
const harnessOfKind = (kind: LockedHarness) => HARNESSES.find(h => h.kind === kind) as TopicHarnessAdapter

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
  const harness = harnessFor(topic)
  if (harness?.tracesInbound) log(`inbound topic ${topic} message ${msg.message_id ?? '(no id)'} text=${typeof msg.text === 'string'} kind=${Object.keys(msg).filter(k => ['text','photo','document','voice','sticker','location','venue','forum_topic_created','forum_topic_edited'].includes(k)).join(',') || 'other'}`)

  // Secret drop runs before every relay path, the square included, so the
  // value can reach neither a topic-Claude nor a peer. See handleSecretDrop.
  if (typeof msg.text === 'string' && SECRET_CMD_RE.test(msg.text)) {
    await handleSecretDrop(String(ctx.chat.id), topic, msg.message_id, String(ctx.from?.id ?? ''), msg.text)
    return
  }
  const here: TopicContext = { chatId: String(ctx.chat.id), topic, fromId: String(ctx.from?.id ?? '') }
  for (const h of HARNESSES) {
    const lockMatch = typeof msg.text === 'string' ? h.lockCommand.exec(msg.text) : null
    if (lockMatch) {
      await h.lock(here, lockMatch[1] ?? '')
      return
    }
  }
  if (typeof msg.text === 'string' && RELAUNCH_RE.test(msg.text)) {
    await handleRelaunch(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''))
    return
  }
  const modelMatch = MODEL_RE.exec(msg.text ?? '')
  if (modelMatch) {
    if (harness) {
      await harness.model(here, modelMatch[1] ?? '')
    } else {
      await handleModelCommand(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''), modelMatch[1] ?? '')
    }
    return
  }
  if (USAGE_RE.test(msg.text ?? '')) {
    if (!ADMIN_USER_ID || String(ctx.from?.id ?? '') !== ADMIN_USER_ID) {
      await sayIn(String(ctx.chat.id), topic, 'Only the operator can inspect provider usage.')
    } else if (harness) {
      await harness.usage(here)
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
    harness?.rename(topic, nm)
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
      harness?.rename(topic, nm)
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

  const takesFiles = harness?.attachments !== 'none'
  let imagePath: string | undefined
  if (takesFiles && desc.photo) {
    imagePath = (await downloadFile(desc.photo.file_id, desc.photo.file_unique_id)) ?? undefined
  }

  // Claude topics can lazily call download_attachment through their MCP. The
  // Antigravity and OpenCode harnesses do not load that Claude plugin, so the
  // proxy eagerly materializes non-photo attachments and supplies the safe
  // local path in the channel metadata instead.
  let attachmentPath: string | undefined
  if (harness?.attachments === 'eager' && desc.attachment && !imagePath) {
    attachmentPath = (await downloadFile(desc.attachment.file_id, desc.attachment.name)) ?? undefined
  }

  let voiceTranscribed = false
  if (takesFiles && desc.attachment?.kind === 'voice') {
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

  if (harness) {
    await harness.receive(here, {
      ...(msg.message_id != null ? { messageId: msg.message_id } : {}),
      ...(typeof msg.text === 'string' ? { text: msg.text } : {}),
      content: desc.content,
      meta,
    })
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

    if (await antigravity.handleCallback(ctx, cb, currentTopic)) return

    if (await handleRouteCallback(ctx, cb)) return

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
    return Promise.resolve(json(resumeNoticeTurn(topic, content)))
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

  harnessFor(topic)?.sent(topic, ids.length)

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
resumePendingPanes()
void refreshProviderCapacity()
void antigravity.refreshUsage(false).catch(() => {})
if (Number.isFinite(CAPACITY_POLL_MS) && CAPACITY_POLL_MS >= 60_000) {
  setInterval(() => void refreshProviderCapacity(), CAPACITY_POLL_MS)
  setInterval(() => void antigravity.refreshUsage(true).catch(() => {}), CAPACITY_POLL_MS)
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
