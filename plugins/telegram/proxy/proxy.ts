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
  chmodSync,
  renameSync,
  rmSync,
  statSync,
  realpathSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'
import { spawnSync } from 'child_process'
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'

// ---- paths -----------------------------------------------------------------

const PLUGIN_ROOT = join(import.meta.dir, '..')
const STATE_DIR =
  process.env.TELEGRAM_TOPICS_STATE_DIR ??
  join(homedir(), '.claude', 'channels', 'telegram-topics')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const REGISTRY_FILE = join(STATE_DIR, 'registry.json')
const PID_FILE = join(STATE_DIR, 'proxy.pid')
const OVERRIDE_SETTINGS = join(PLUGIN_ROOT, 'override-settings.json')
const LAUNCH_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'launch-topic.sh')
// The token-bearing .env files. assertSendable refuses to ship these so a
// prompt-injected topic-Claude cannot exfil the bot token via reply(files:[...]).
const ENV_FILES = [join(PLUGIN_ROOT, '.env'), join(STATE_DIR, '.env')]

// ---- env -------------------------------------------------------------------

// Load a .env into process.env WITHOUT overriding a value already in the real
// environment. The token is a credential, so lock the file to the owner.
function loadEnvFile(f: string): void {
  try {
    chmodSync(f, 0o600)
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
    }
  } catch {}
}
loadEnvFile(join(PLUGIN_ROOT, '.env'))
loadEnvFile(join(STATE_DIR, '.env'))

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID
const SPAWN_DIR = process.env.TELEGRAM_TOPICS_SPAWN_DIR ?? homedir()
const PORT = parseInt(process.env.TELEGRAM_PROXY_PORT ?? '8790', 10)
const MARKETPLACE = process.env.TELEGRAM_TOPICS_MARKETPLACE ?? 'plugin:telegram@zamua'
const PROXY_URL = `http://localhost:${PORT}`

function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} telegram-topics-proxy: ${m}\n`)
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

// ---- Telegram helpers (ported from the single-session server) --------------

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

// reply's files param takes any path, and the proxy would InputFile+send it.
// A prompt-injected topic-Claude could call reply(files:['.../telegram-topics/.env'])
// to ship the bot token to the group. Refuse the proxy's own state (everything
// under STATE_DIR except the inbox subdir) and the token-bearing .env files.
// Claude can already Read+paste arbitrary file contents, so this is not a new
// exfil channel for other paths - it just closes the one path Claude has no
// reason to ever send: the server's own credentials/state.
function assertSendable(f: string): void {
  const real = realOrNull(f)
  if (real === null) return // statSync will fail with a proper error later
  const stateReal = realOrNull(STATE_DIR)
  if (stateReal) {
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }
  for (const envf of ENV_FILES) {
    const er = realOrNull(envf)
    if (er && real === er) {
      throw new Error(`refusing to send credential file: ${f}`)
    }
  }
}

// Telegram caps messages at 4096 chars. Split long replies on the char count.
function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    out.push(rest.slice(0, limit))
    rest = rest.slice(limit)
  }
  if (rest) out.push(rest)
  return out
}

// Uploader-controlled names land inside the <channel> meta; strip delimiters so
// they cannot break out of the tag or forge a second meta entry.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

type Described = {
  content: string
  attachment?: AttachmentMeta
  photo?: { file_id: string; file_unique_id: string }
}

// Turn a Telegram message into the channel content string plus any attachment /
// photo descriptors. Returns null for messages we do not relay (service
// messages with no user content).
function describeMessage(msg: any): Described | null {
  if (typeof msg.text === 'string') return { content: msg.text }
  if (msg.photo) {
    const best = msg.photo[msg.photo.length - 1]
    return {
      content: msg.caption ?? '(photo)',
      photo: { file_id: best.file_id, file_unique_id: best.file_unique_id },
    }
  }
  if (msg.document) {
    const d = msg.document
    const name = safeName(d.file_name)
    return {
      content: msg.caption ?? `(document: ${name ?? 'file'})`,
      attachment: { kind: 'document', file_id: d.file_id, size: d.file_size, mime: d.mime_type, name },
    }
  }
  if (msg.voice) {
    const v = msg.voice
    return {
      content: msg.caption ?? '(voice message)',
      attachment: { kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type },
    }
  }
  if (msg.audio) {
    const a = msg.audio
    const name = safeName(a.file_name)
    return {
      content: msg.caption ?? `(audio: ${safeName(a.title) ?? name ?? 'audio'})`,
      attachment: { kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name },
    }
  }
  if (msg.video) {
    const v = msg.video
    return {
      content: msg.caption ?? '(video)',
      attachment: {
        kind: 'video',
        file_id: v.file_id,
        size: v.file_size,
        mime: v.mime_type,
        name: safeName(v.file_name),
      },
    }
  }
  if (msg.video_note) {
    const v = msg.video_note
    return { content: '(video note)', attachment: { kind: 'video_note', file_id: v.file_id, size: v.file_size } }
  }
  if (msg.sticker) {
    const s = msg.sticker
    const emoji = s.emoji ? ` ${s.emoji}` : ''
    return { content: `(sticker${emoji})`, attachment: { kind: 'sticker', file_id: s.file_id, size: s.file_size } }
  }
  return null
}

// ---- per-topic state -------------------------------------------------------

type InboundMsg = { content: string; meta: Record<string, string> }
type PermAnswer = { request_id: string; behavior: 'allow' | 'deny' }

type TopicState = {
  queue: InboundMsg[]
  waiters: Array<(m: InboundMsg | null) => void>
  // Permission answers ride a SEPARATE queue + long-poll (GET /permission-poll)
  // so a Telegram "yes <id>" reply is delivered ONLY to the topic-MCP that
  // asked, never mixed into (or consumed by) the normal channel /poll stream.
  permQueue: PermAnswer[]
  permWaiters: Array<(a: PermAnswer | null) => void>
  threadId?: number // undefined for "general"
  name: string
  session: string
  spawnedAt: number
  spawning: boolean
  // The claude session id for this topic, minted on the FIRST spawn (passed via
  // --session-id) and reused via --resume on every later spawn. This is what
  // makes a topic one continuous conversation across kills / crashes / proxy
  // restarts: all topics share one spawn dir, so bare --continue (most-recent
  // session in a dir) cannot tell them apart - we track the id explicitly.
  claudeSessionId?: string
}

const topics = new Map<string, TopicState>()
// forum_topic_created names learned before a topic's session is spawned.
const topicNames = new Map<string, string>()

// tmux session names cannot contain '.' or ':'; strip the group id's sign and
// any punctuation so a negative supergroup id (e.g. -1001234567890) is safe.
function sessionNameFor(topic: string): string {
  const cid = String(GROUP_CHAT_ID).replace(/[^0-9]/g, '')
  const t = topic.replace(/[^A-Za-z0-9]/g, '') || 'x'
  return `tg-${cid}-${t}`
}

function getTopic(topic: string): TopicState {
  let st = topics.get(topic)
  if (!st) {
    st = {
      queue: [],
      waiters: [],
      permQueue: [],
      permWaiters: [],
      threadId: topic === 'general' ? undefined : Number(topic),
      name: '',
      session: sessionNameFor(topic),
      spawnedAt: 0,
      spawning: false,
    }
    topics.set(topic, st)
  }
  return st
}

function enqueue(topic: string, msg: InboundMsg): void {
  const st = getTopic(topic)
  const waiter = st.waiters.shift()
  if (waiter) waiter(msg)
  else st.queue.push(msg)
}

// ---- permission relay -----------------------------------------------------
//
// A topic-Claude runs detached, so it cannot answer a permission prompt for
// Bash/WebFetch/etc. Instead its MCP forwards the prompt here (POST
// /permission-request); the proxy posts an approve/deny prompt INTO that
// topic's Telegram thread and remembers request_id -> topic. When the user
// answers (inline button or a "yes <id>" / "no <id>" text reply), the proxy
// routes {request_id, behavior} back to the ORIGIN topic's /permission-poll,
// and the MCP fires notifications/claude/channel/permission with it.

type PendingPerm = { topic: string; createdAt: number }
const pendingPerms = new Map<string, PendingPerm>() // key = request_id
const PENDING_PERM_TTL_MS = 60 * 60 * 1000

// Matches "yes <id>" / "no <id>" (also y/n). The <id> is matched loosely; the
// pendingPerms lookup below is the real gate, so conversational "no thanks"
// (token "thanks" is not a pending request) is never intercepted.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+(\S+)\s*$/i

// Drop stale unanswered requests so the map cannot grow unbounded. A pruned
// entry only means a very late reply won't route; the origin session stays
// blocked until answered or restarted (documented behavior).
function prunePendingPerms(): void {
  const now = Date.now()
  for (const [id, p] of pendingPerms) {
    if (now - p.createdAt > PENDING_PERM_TTL_MS) pendingPerms.delete(id)
  }
}

// Deliver an answer to the topic that ASKED (pending.topic), regardless of
// which thread the button/reply came from, and clear the pending entry.
function resolvePermission(requestId: string, behavior: 'allow' | 'deny'): boolean {
  const pending = pendingPerms.get(requestId)
  if (!pending) return false
  pendingPerms.delete(requestId)
  const st = getTopic(pending.topic)
  const answer: PermAnswer = { request_id: requestId, behavior }
  const waiter = st.permWaiters.shift()
  if (waiter) waiter(answer)
  else st.permQueue.push(answer)
  return true
}

// ---- tmux -----------------------------------------------------------------

function liveTmuxSessions(): Set<string> {
  const r = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' })
  if (r.status !== 0) return new Set() // no server running -> no sessions
  return new Set(
    (r.stdout ?? '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean),
  )
}

// ---- registry --------------------------------------------------------------

type RegistryEntry = {
  tmux_session: string
  thread_id: number | null
  name: string
  spawned_at: number
  claude_session_id: string | null
}

function saveRegistry(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const out: Record<string, RegistryEntry> = {}
  for (const [topic, st] of topics) {
    // Persist any topic that has been spawned at least once (has a claude
    // session id), even if its tmux session is currently dead - we need the id
    // to --resume the SAME conversation on the next message.
    if (!st.claudeSessionId) continue
    out[topic] = {
      tmux_session: st.session,
      thread_id: st.threadId ?? null,
      name: st.name,
      spawned_at: st.spawnedAt,
      claude_session_id: st.claudeSessionId,
    }
  }
  const tmp = REGISTRY_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n')
  renameSync(tmp, REGISTRY_FILE)
}

// Load the registry and RECONCILE against the live tmux sessions: re-adopt
// entries whose session is still up (so a proxy restart re-adopts live
// sessions) and forget the rest (dead sessions).
function loadAndReconcileRegistry(): void {
  let raw: Record<string, RegistryEntry> = {}
  try {
    raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
  } catch {
    raw = {}
  }
  const live = liveTmuxSessions()
  for (const [topic, entry] of Object.entries(raw)) {
    const st = getTopic(topic)
    st.threadId = entry.thread_id ?? undefined
    st.name = entry.name
    st.claudeSessionId = entry.claude_session_id ?? undefined
    if (entry.name) topicNames.set(topic, entry.name)
    if (entry.tmux_session && live.has(entry.tmux_session)) {
      st.session = entry.tmux_session
      st.spawnedAt = entry.spawned_at
      log(`re-adopted live topic ${topic} "${entry.name}" (${entry.tmux_session})`)
    } else {
      // Session is dead, but KEEP the claude session id so the next message
      // re-spawns and --resumes the SAME conversation instead of starting fresh.
      st.session = ''
      st.spawnedAt = 0
      log(`topic ${topic} "${entry.name}" not live; will resume claude session ${entry.claude_session_id ?? '(none)'} on next message`)
    }
  }
  saveRegistry()
}

// ---- spawn (single-flight) -------------------------------------------------

function kickoffPrompt(topicLabel: string): string {
  return (
    `SYSTEM STARTUP NOTICE (not a user message): you are the Claude for the ${topicLabel} topic. ` +
    `Do NOT greet or send anything yet. Wait for the first real user message - it will arrive as a ` +
    `<channel> turn - and respond to THAT via the telegram MCP (it targets this topic). Your working ` +
    `dir is ${SPAWN_DIR}. IMPORTANT: other Claudes may be running concurrently on this same machine, ` +
    `un-sandboxed and possibly in overlapping dirs, so be careful with destructive or global actions ` +
    `and with shared state, and do not assume you are alone.`
  )
}

// Ensure a live tmux Claude session exists for a topic. Single-flight: the
// synchronous spawnSync blocks the event loop for the whole launch, so two
// inbound messages for a brand-new topic cannot spawn two sessions; the
// spawning flag + the live-session dedup are belt and suspenders.
function ensureSession(topic: string): void {
  const st = getTopic(topic)
  if (st.spawning) return
  const name = sessionNameFor(topic)
  if (liveTmuxSessions().has(name)) {
    st.session = name
    if (!st.spawnedAt) {
      st.spawnedAt = Date.now()
      saveRegistry()
    }
    return
  }
  st.spawning = true
  try {
    const label = st.name || topicNames.get(topic) || topic
    st.name = label
    // First spawn: mint a session id and create the session with it (passing
    // the kickoff). Every later spawn RESUMES that same id (no kickoff), so the
    // topic stays one continuous conversation. The id is persisted in the
    // registry, so it survives proxy restarts too.
    const resuming = !!st.claudeSessionId
    if (!st.claudeSessionId) st.claudeSessionId = crypto.randomUUID()
    const env = {
      ...process.env,
      TG_SESSION: name,
      TG_SPAWN_DIR: SPAWN_DIR,
      TELEGRAM_TOPIC_ID: topic,
      TELEGRAM_PROXY_URL: PROXY_URL,
      TG_MARKETPLACE: MARKETPLACE,
      TG_SETTINGS: OVERRIDE_SETTINGS,
      TG_KICKOFF: kickoffPrompt(label),
      TG_CLAUDE_SESSION_ID: st.claudeSessionId,
      TG_RESUME: resuming ? '1' : '',
    }
    const r = spawnSync('bash', [LAUNCH_SCRIPT], { env, encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`launcher exit ${r.status}: ${(r.stderr || '').trim()}`)
    }
    st.session = name
    st.spawnedAt = Date.now()
    saveRegistry()
    log(`${resuming ? 'resumed' : 'spawned'} topic ${topic} "${label}" (claude ${st.claudeSessionId}) -> tmux ${name}`)
  } catch (e) {
    log(`spawn failed for topic ${topic}: ${e}`)
  } finally {
    st.spawning = false
  }
}

// ---- file download (photo inbound + /download) -----------------------------

async function downloadFile(fileId: string, uniqueHint?: string): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return null
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    // file_path is from Telegram (trusted) but strip to safe chars anyway.
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const uid = (file.file_unique_id ?? uniqueHint ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    mkdirSync(INBOX_DIR, { recursive: true })
    const path = join(INBOX_DIR, `${Date.now()}-${uid}.${ext}`)
    writeFileSync(path, buf)
    return path
  } catch (e) {
    log(`download failed for ${fileId}: ${e}`)
    return null
  }
}

// ---- grammy inbound --------------------------------------------------------

const bot = new Bot(TOKEN)

bot.catch(err => {
  process.stderr.write(`telegram-topics-proxy: handler error (polling continues): ${err.error}\n`)
})

bot.on('message', async ctx => {
  const msg = ctx.message
  // Access control: only the configured forum group. Everything else dropped.
  if (String(ctx.chat.id) !== String(GROUP_CHAT_ID)) return

  const topic = msg.message_thread_id != null ? String(msg.message_thread_id) : 'general'

  // Learn topic names from the creation service message; do not relay it.
  if (msg.forum_topic_created) {
    const nm = msg.forum_topic_created.name
    topicNames.set(topic, nm)
    const st = topics.get(topic)
    if (st && !st.name) st.name = nm
    log(`learned topic ${topic} name "${nm}"`)
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

  let imagePath: string | undefined
  if (desc.photo) {
    imagePath = (await downloadFile(desc.photo.file_id, desc.photo.file_unique_id)) ?? undefined
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

  // Spawn the topic's Claude if none is live, then enqueue. The message waits
  // in the queue until the new MCP's first /poll drains it (nothing is lost
  // during the ~1-2s spawn+register window).
  ensureSession(topic)
  enqueue(topic, { content: desc.content, meta })
})

// Inline-button answers for permission prompts. Callback data is
// `tgperm:allow:<request_id>` / `tgperm:deny:<request_id>`. Access control is
// the group gate: only members of the configured forum group can tap a button
// that lives in that group's thread.
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data ?? ''
  const m = /^tgperm:(allow|deny):(.+)$/.exec(data)
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const cbChatId = ctx.callbackQuery.message?.chat.id
  if (String(cbChatId) !== String(GROUP_CHAT_ID)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const behavior = m[1] as 'allow' | 'deny'
  const requestId = m[2]
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

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Outbound gate: reply/react/edit/download can only target the configured group.
function assertGroup(chatId: unknown): void {
  if (String(chatId) !== String(GROUP_CHAT_ID)) {
    throw new Error(`chat ${chatId} is not the configured group`)
  }
}

function threadIdForTopic(topic: string): number | undefined {
  return topic === 'general' ? undefined : Number(topic)
}

function handlePoll(url: URL): Promise<Response> {
  const topic = url.searchParams.get('topic') ?? 'general'
  const st = getTopic(topic)
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
  const b = (await req.json()) as any
  assertGroup(b.chat_id)
  const chatId = String(b.chat_id)
  const topic = String(b.topic ?? 'general')
  const threadId = threadIdForTopic(topic)
  const text = String(b.text ?? '')
  const replyTo = b.reply_to != null ? Number(b.reply_to) : undefined
  const files: string[] = Array.isArray(b.files) ? b.files : []
  const parseMode = b.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined

  for (const f of files) {
    assertSendable(f)
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

  return json({ message_ids: ids })
}

async function handleReact(req: Request): Promise<Response> {
  const b = (await req.json()) as any
  assertGroup(b.chat_id)
  await bot.api.setMessageReaction(String(b.chat_id), Number(b.message_id), [
    { type: 'emoji', emoji: b.emoji as ReactionTypeEmoji['emoji'] },
  ])
  return json({ ok: true })
}

async function handleEdit(req: Request): Promise<Response> {
  const b = (await req.json()) as any
  assertGroup(b.chat_id)
  const parseMode = b.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
  const edited = await bot.api.editMessageText(
    String(b.chat_id),
    Number(b.message_id),
    String(b.text),
    ...(parseMode ? [{ parse_mode: parseMode }] : []),
  )
  const id = typeof edited === 'object' ? edited.message_id : Number(b.message_id)
  return json({ message_id: id })
}

async function handleDownload(req: Request): Promise<Response> {
  const b = (await req.json()) as any
  const path = await downloadFile(String(b.file_id))
  if (!path) throw new Error('download failed (file may have expired)')
  return json({ path })
}

// A topic-MCP forwards a harness permission prompt here. Remember it against
// the origin topic and post an approve/deny prompt into that topic's thread.
async function handlePermissionRequest(req: Request): Promise<Response> {
  const b = (await req.json()) as any
  const topic = String(b.topic ?? 'general')
  const requestId = String(b.request_id ?? '')
  const tool = String(b.tool ?? 'tool')
  const input = b.input != null ? String(b.input) : ''
  if (!requestId) throw new Error('permission-request requires request_id')

  prunePendingPerms()
  pendingPerms.set(requestId, { topic, createdAt: Date.now() })

  const threadId = threadIdForTopic(topic)
  const trimmed = input.length > 500 ? input.slice(0, 500) + '…' : input
  const preview = trimmed ? `\n\n${trimmed}` : ''
  const text =
    `🔐 Permission: ${tool}${preview}\n\n` +
    `Tap a button, or reply "yes ${requestId}" to allow / "no ${requestId}" to deny.`
  const keyboard = new InlineKeyboard()
    .text('✅ Allow', `tgperm:allow:${requestId}`)
    .text('❌ Deny', `tgperm:deny:${requestId}`)
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
    log(`replacing stale proxy pid=${stale}`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

loadAndReconcileRegistry()

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
            if (req.method === 'GET' && url.pathname === '/poll') return handlePoll(url)
            if (req.method === 'GET' && url.pathname === '/permission-poll') {
              return handlePermissionPoll(url)
            }
            if (req.method === 'GET' && url.pathname === '/health') {
              return json({
                ok: true,
                topics: [...topics.keys()],
                port: PORT,
                polling: pollingSince != null,
                polling_since: pollingSince != null ? new Date(pollingSince).toISOString() : null,
              })
            }
            if (req.method === 'POST' && url.pathname === '/send') return await handleSend(req)
            if (req.method === 'POST' && url.pathname === '/react') return await handleReact(req)
            if (req.method === 'POST' && url.pathname === '/edit') return await handleEdit(req)
            if (req.method === 'POST' && url.pathname === '/download') return await handleDownload(req)
            if (req.method === 'POST' && url.pathname === '/permission-request') {
              return await handlePermissionRequest(req)
            }
            return new Response('not found', { status: 404 })
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e)
            return json({ error: m }, 500)
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
            `polling as @${info.username}; group ${GROUP_CHAT_ID}; spawn dir ${SPAWN_DIR}; marketplace ${MARKETPLACE}`,
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
