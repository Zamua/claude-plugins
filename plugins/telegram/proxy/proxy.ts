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
  existsSync,
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
// The Stop hook that keeps replies out of the transcript. override-settings.json
// references it as $TG_HOOK (passed to the session via `tmux new-session -e`) so
// that committed file needs no hardcoded path.
const STOP_HOOK = join(PLUGIN_ROOT, 'hooks', 'stop-reply-guard.py')
// The StopFailure hook that reports a usage-limit stall so we can fail the
// topic over to the fallback model (see MODEL_FALLBACK / handleRateLimit).
const FAILOVER_HOOK = join(PLUGIN_ROOT, 'hooks', 'rate-limit-failover.py')
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

// ---- effort (ultracode) ----------------------------------------------------
// Every topic-Claude runs at ultracode (xhigh) effort by default. `ultracode` is
// a SETTINGS key (`"ultracode": true`), NOT a CLI flag (--effort rejects the
// value), and repeated --settings is last-wins rather than merged - so we bake it
// into the ONE settings file the launcher passes: an effective-settings.json =
// the committed override-settings.json base + `ultracode` from
// TELEGRAM_TOPICS_ULTRACODE (default on). Regenerated on every proxy start, so a
// config change lands on the next restart. Set TELEGRAM_TOPICS_ULTRACODE=false to
// run topics at the default (medium) effort. (Measured: ultracode:true flips the
// hook-reported effort.level medium -> xhigh.)
// Recognized true/false tokens; an UNRECOGNIZED non-empty value (a typo like
// "ture") falls back to the default and logs, rather than silently reading as
// false - for a default-ON flag a silent-OFF typo is exactly the "wrong effort"
// footgun we want to avoid.
function envBool(v: string | undefined, dflt: boolean, name: string): boolean {
  const s = (v ?? '').trim().toLowerCase()
  if (s === '') return dflt
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false
  log(`${name}="${v}" is not a recognized boolean; using default (${dflt})`)
  return dflt
}
const ULTRACODE = envBool(process.env.TELEGRAM_TOPICS_ULTRACODE, true, 'TELEGRAM_TOPICS_ULTRACODE')

// Default model for every topic-Claude, passed to the launcher (TG_MODEL) as the
// `--model` FLAG. NOT a settings `model` key: that is only a DEFAULT and is
// IGNORED by a --resume'd interactive session (it restores its own baked-in
// model), so an existing topic would keep its old model forever; the --model flag
// overrides even on resume (verified end-to-end). Default the `fable` alias;
// TELEGRAM_TOPICS_MODEL=<id> pins another model, and `default`/`inherit`/empty
// leaves it unset so the account default applies. (The single-session bridge
// chooses its own model separately - this is topic-Claudes only.)
function resolveModel(): string {
  const raw = process.env.TELEGRAM_TOPICS_MODEL
  // Prefer the ALIAS ('fable') over a pinned id: aliases track the newest
  // model in that family, so a release does not require touching config.
  if (raw === undefined) return 'fable'
  const s = raw.trim()
  if (s === '' || s.toLowerCase() === 'default' || s.toLowerCase() === 'inherit') return ''
  return s
}
const MODEL = resolveModel()

// Fallback model for a topic whose primary model hits its PLAN USAGE LIMIT
// (HTTP 429). Claude Code's own fallbackModel chain is availability-based
// (503/529) and documented to exclude rate limits, and nothing downgrades the
// model automatically on a plan limit - so without this an interactive topic
// just stalls until a human runs /model. The StopFailure hook
// (hooks/rate-limit-failover.py) reports the stall here and handleRateLimit
// respawns the topic on this model with --resume (the --model FLAG overrides
// even on resume, which is what makes this work at all). Empty = disabled
// (the topic stalls as before). Reset back to the primary at the nightly
// restart, so a fallback is never permanent.
const MODEL_FALLBACK = (process.env.TELEGRAM_TOPICS_MODEL_FALLBACK ?? 'opus').trim()
// How long a failed-over topic waits before RE-TRYING its primary model when
// the limit error carried no reset time. The retry is free: if the quota is
// still exhausted the topic just fails over again (one notice, conversation
// continues), so this is a "probe optimistically" knob, not a guess that has
// to be right. Ignored when a reset time IS known - that is exact.
const FALLBACK_PROBE_MIN = Number(process.env.TELEGRAM_TOPICS_FALLBACK_PROBE_MINUTES ?? '60')

// Which terminal multiplexer hosts the detached topic-Claude sessions.
// `tmux` (default, the original backend) or `herdr` (herdr.dev, the agent
// multiplexer - adds per-agent state visibility + a socket API). Selected once
// at boot; the port/adapter split lives in the "multiplexer" section below and
// the spawn mechanics live in scripts/launch-topic.sh (branch on TG_MUX).
// Prereqs for herdr are documented in the plugin CLAUDE.md (server running,
// e.g. via a launchd agent; Full Disk Access granted to the herdr binary so
// topic-Claudes inherit it - the same grant tmux holds today).
function resolveMux(): 'tmux' | 'herdr' {
  const raw = (process.env.TELEGRAM_TOPICS_MULTIPLEXER ?? 'tmux').trim().toLowerCase()
  if (raw === 'tmux' || raw === 'herdr') return raw
  log(`TELEGRAM_TOPICS_MULTIPLEXER="${raw}" is not tmux|herdr; using tmux`)
  return 'tmux'
}
const MUX_KIND = resolveMux()

// ---- the square (inter-Claude collaboration) --------------------------------
// One designated forum topic hosts ALL agent-to-agent conversations (design:
// "private rooms + one commons"). Empty/unset = the square is disabled and
// every square endpoint 404s. The topic is identified by thread id, created
// once by the operator (or the bot - it has can_manage_topics).
const SQUARE_TOPIC = (process.env.TELEGRAM_TOPICS_SQUARE_TOPIC_ID ?? '').trim()
// Idle conversations are pruned from the ROUTING registry after this many
// hours (the Telegram thread itself stays readable forever - closing only
// stops routing). No hop caps / rate limits by design: discipline is the
// per-delivery norm line; Telegram's per-group limits are the only throttle.
const CONV_TTL_HOURS = Number(process.env.TELEGRAM_TOPICS_CONV_TTL_HOURS ?? '48')
const EFFECTIVE_SETTINGS = join(STATE_DIR, 'effective-settings.json')
// Called PER SPAWN (not once at module load) so each (re)spawn reflects the
// CURRENT committed override-settings.json - a base-settings edit (e.g. a git
// pull) then reaches topics on their next respawn (the nightly restart, a kill),
// matching the pre-generation behavior where spawns read the base file live. Also
// self-heals if the generated file is removed. On any read/write error it falls
// back to the committed base un-generated (topics still spawn, just without the
// ultracode override).
function resolveSettings(): string {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const base = JSON.parse(readFileSync(OVERRIDE_SETTINGS, 'utf8'))
    base.ultracode = ULTRACODE
    // NB the MODEL is NOT baked in here: a settings `model` is only a default and
    // is ignored by a --resume'd interactive session. The launcher passes MODEL as
    // the --model FLAG (via TG_MODEL) instead, which overrides even on resume.
    writeFileSync(EFFECTIVE_SETTINGS, JSON.stringify(base, null, 2) + '\n')
    return EFFECTIVE_SETTINGS
  } catch (e) {
    log(`could not generate effective settings (${e}); using override-settings.json - ultracode NOT applied`)
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
  // Set when this topic has been failed over to MODEL_FALLBACK after a plan
  // usage limit (429) on its primary model. Every later spawn uses it until
  // the nightly restart clears it, so a proxy restart cannot silently drop
  // the topic back onto an exhausted model.
  fallbackModel?: string
  // When the primary model may be retried: the quota reset time parsed from
  // the limit error, or (absent that) failover time + FALLBACK_PROBE_MIN.
  fallbackUntil?: number
}

const topics = new Map<string, TopicState>()
// forum_topic_created names learned before a topic's session is spawned.
const topicNames = new Map<string, string>()

// A readable, tmux-safe slug from a topic name (tmux names cannot contain '.' or
// ':', so collapse every non-alphanumeric run to '-', trim, and cap the length).
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'topic'
  )
}

// The tmux session name. Readable: `claude-<slug>-<thread_id>` (e.g.
// `claude-hostthis-34`), with the numeric thread id as a short, stable,
// collision-proof suffix; the General topic (no thread id) is just
// `claude-general`. Computed from the topic's LABEL at spawn time and then
// RECORDED in st.session (dedup/kill use the recorded string, never re-derive) so
// a later rename can't orphan the running session.
function sessionNameFor(topic: string, label?: string): string {
  if (topic === 'general') return 'claude-general'
  const id = topic.replace(/[^A-Za-z0-9]/g, '')
  const slug = slugify(label ?? '')
  // Unknown/degenerate name (the label fell back to the numeric id, or slugified
  // to the 'topic' placeholder) -> just `claude-<id>`, not `claude-<id>-<id>`.
  if (slug === id || slug === 'topic') return `claude-${id}`
  return `claude-${slug}-${id}`
}

// The pre-2026-07 `tg-<cid>-<tid>` name. Used ONLY by the migration bridge in
// ensureSession to ADOPT a still-live old-scheme session (rather than spawning a
// second one under the new name) - the launcher's has-session guard keys off the
// NEW name so it cannot catch an old-named orphan. Removable once no `tg-*`
// sessions remain in the wild.
function legacySessionNameFor(topic: string): string {
  const cid = String(GROUP_CHAT_ID).replace(/[^0-9]/g, '')
  return `tg-${cid}-${topic.replace(/[^A-Za-z0-9]/g, '') || 'x'}`
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
      // Empty until the first spawn computes it from the resolved label; the
      // reconcile / spawn paths fill it in. Dedup treats '' as "no live session".
      session: '',
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

// Kill a topic's session AND drop the long-polls that belonged to it.
//
// The proxy cannot observe an MCP dying: its /poll waiter stays registered in
// st.waiters until it times out ~25s later. enqueue() prefers a waiter over
// the queue, so a message enqueued in that window is handed to a process that
// no longer exists and is LOST - it never reaches the queue the respawned
// session drains. That is exactly how the first real usage-limit failover
// failed (2026-07-19): the nudge vanished into the killed session, so the
// Claude that came back on the fallback model had nothing to do and sat idle
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
  return killed
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

// ---- multiplexer (port + adapters) ------------------------------------------
//
// The proxy's core is multiplexer-agnostic: it needs exactly two operations on
// the host that keeps detached topic-Claudes alive - "which sessions are live"
// (by name) and "kill this session" (by name). This PORT captures that; the
// two ADAPTERS below implement it for tmux and herdr. Spawning is NOT part of
// the port: scripts/launch-topic.sh owns spawn mechanics for both backends
// (branching on TG_MUX), because spawning is where all the backend-specific
// ceremony lives (env propagation, the dev-channel dialog watcher).
// Session NAMES are the shared currency: `claude-<slug>-<tid>` strings recorded
// in st.session / the registry work identically for both backends (a tmux
// session name == a herdr agent/pane label).

interface Multiplexer {
  readonly kind: 'tmux' | 'herdr'
  liveSessions(): Set<string>
  kill(session: string): boolean
}

class TmuxMux implements Multiplexer {
  readonly kind = 'tmux' as const

  liveSessions(): Set<string> {
    const r = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' })
    if (r.status !== 0) return new Set() // no server running -> no sessions
    return new Set(
      (r.stdout ?? '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean),
    )
  }

  kill(session: string): boolean {
    // '=' forces an exact-name match (claude-x-4 must not match claude-x-45).
    const r = spawnSync('tmux', ['kill-session', '-t', `=${session}`], { encoding: 'utf8' })
    return r.status === 0
  }
}

class HerdrMux implements Multiplexer {
  readonly kind = 'herdr' as const
  // launchd/detached parents run with a minimal PATH; prefer the brew path.
  private readonly bin = existsSync('/opt/homebrew/bin/herdr') ? '/opt/homebrew/bin/herdr' : 'herdr'

  // `herdr pane list` emits one JSON object; panes carry the agent NAME as
  // `label` (set by `herdr agent start <name>` in the launcher), which is our
  // session-name currency. pane_id is a herdr-internal handle we only need
  // transiently for kill().
  private panes(): Map<string, { paneId: string; status: string }> {
    const out = new Map<string, { paneId: string; status: string }>()
    const r = spawnSync(this.bin, ['pane', 'list'], { encoding: 'utf8' })
    if (r.status !== 0) return out // server not running -> no sessions
    try {
      const parsed = JSON.parse(r.stdout ?? '{}')
      for (const p of parsed?.result?.panes ?? []) {
        // Keep STALE panes too (agent_status 'unknown'): kill() must be able to
        // close them; only liveSessions() filters them out.
        if (p?.label) {
          out.set(String(p.label), {
            paneId: String(p.pane_id ?? ''),
            status: String(p.agent_status ?? 'unknown'),
          })
        }
      }
    } catch {
      // Unparseable output = treat as no live sessions; callers re-spawn, and
      // the launcher's own dedup guard prevents doubles if herdr was just slow.
    }
    return out
  }

  // A LABEL ALONE DOES NOT MEAN LIVE. herdr restores its panes on login (from
  // session.json) with their labels intact, but the claude process inside died
  // with the logout - leaving an empty shell that herdr reports as
  // `agent_status: "unknown"` (a real agent reports idle/working/done/blocked).
  // Counting those as live made the proxy "re-adopt" the corpse on boot and
  // NEVER respawn the topic, so messages queued for a session that did not
  // exist. Measured 2026-07-23 after a logout/login: claude-general and
  // claude-macos-944 were labeled panes with agent_status 'unknown' and zero
  // claude processes, yet were re-adopted as live. Require a real agent.
  // NB 'unknown' is also reported for ~2s while a freshly spawned pane boots,
  // so ensureSession additionally honors a short post-spawn grace window.
  liveSessions(): Set<string> {
    const out = new Set<string>()
    for (const [label, p] of this.panes()) {
      if (p.status && p.status !== 'unknown') out.add(label)
    }
    return out
  }

  kill(session: string): boolean {
    const paneId = this.panes().get(session)?.paneId
    if (!paneId) return false
    const r = spawnSync(this.bin, ['pane', 'close', paneId], { encoding: 'utf8' })
    return r.status === 0
  }
}

const mux: Multiplexer = MUX_KIND === 'herdr' ? new HerdrMux() : new TmuxMux()

// How long after a spawn we still treat a topic as live even if the multiplexer
// cannot see an agent yet (herdr reports `agent_status: "unknown"` for the first
// ~2s of a pane's life). Generous enough to cover a slow boot, short enough that
// a genuinely failed spawn is retried on the next message.
const SPAWN_GRACE_MS = 30_000

// ---- registry --------------------------------------------------------------

type RegistryEntry = {
  tmux_session: string
  thread_id: number | null
  name: string
  spawned_at: number
  claude_session_id: string | null
  fallback_model?: string | null
  fallback_until?: number | null
}

function saveRegistry(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const out: Record<string, RegistryEntry> = {}
  for (const [topic, st] of topics) {
    // Persist any topic that has been spawned at least once (has a claude
    // session id - needed to --resume the SAME conversation on the next
    // message) OR that has a known NAME with no session yet (a proxy-created
    // topic, registered at creation time; without persisting it here a proxy
    // restart would make it invisible again until a human messaged it).
    if (!st.claudeSessionId && !st.name) continue
    out[topic] = {
      tmux_session: st.session,
      thread_id: st.threadId ?? null,
      name: st.name,
      spawned_at: st.spawnedAt,
      claude_session_id: st.claudeSessionId,
      ...(st.fallbackModel ? { fallback_model: st.fallbackModel, fallback_until: st.fallbackUntil ?? null } : {}),
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
  const live = mux.liveSessions()
  for (const [topic, entry] of Object.entries(raw)) {
    const st = getTopic(topic)
    st.threadId = entry.thread_id ?? undefined
    st.name = entry.name
    st.claudeSessionId = entry.claude_session_id ?? undefined
    st.fallbackModel = entry.fallback_model ?? undefined
    st.fallbackUntil = entry.fallback_until ?? undefined
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

// ---- conversations (the square's routing registry) ---------------------------
//
// Durable + rederivable, content-free. One JSON file beside registry.json,
// atomic writes, bounded (LRU cap), TTL-pruned. The conv id is the root
// message id in the square thread; every non-root square message carries
// "#<conv>" in its header, so a lost file rebuilds lazily from
// reply_to_message payloads as replies arrive (self-describing messages).

type Conv = {
  participants: string[] // topic keys ("34", "general"); the operator is an implicit participant of every conv
  last_msg_id: number
  origin_topic: string
  depth: number // DELIVERED claude messages since the last human message. Logged, never enforced.
  updated_at: number
}

const CONV_FILE = join(STATE_DIR, 'conversations.json')
const CONV_CAP = 50
const convs = new Map<string, Conv>()

function pruneConvs(): void {
  const cutoff = Date.now() - CONV_TTL_HOURS * 3600_000
  for (const [id, c] of convs) if (c.updated_at < cutoff) convs.delete(id)
  // LRU-close beyond the cap (oldest first).
  if (convs.size > CONV_CAP) {
    const sorted = [...convs.entries()].sort((a, b) => a[1].updated_at - b[1].updated_at)
    for (const [id] of sorted.slice(0, convs.size - CONV_CAP)) convs.delete(id)
  }
}

function saveConvs(): void {
  pruneConvs()
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = CONV_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(convs), null, 2) + '\n')
    renameSync(tmp, CONV_FILE)
  } catch (e) {
    log(`could not save conversations.json: ${e}`)
  }
}

function loadConvs(): void {
  try {
    const raw = JSON.parse(readFileSync(CONV_FILE, 'utf8')) as Record<string, Conv>
    for (const [id, c] of Object.entries(raw)) convs.set(id, c)
    pruneConvs()
    log(`loaded ${convs.size} conversation(s)`)
  } catch {}
}

// ---- the square: directory, formatting, delivery ----------------------------

// Topic directory: every known topic (live or dormant) addressable by slug.
// The square itself and never-spawned unnamed topics are excluded.
function topicDirectory(): Array<{ slug: string; name: string; topic: string; live: boolean }> {
  const live = mux.liveSessions()
  const out: Array<{ slug: string; name: string; topic: string; live: boolean }> = []
  for (const [topic, st] of topics) {
    if (topic === SQUARE_TOPIC) continue
    const name = st.name || topicNames.get(topic) || ''
    const slug = topic === 'general' ? 'general' : slugify(name) !== 'topic' ? slugify(name) : topic
    out.push({ slug, name: name || topic, topic, live: !!(st.session && live.has(st.session)) })
  }
  return out
}

function resolvePeer(peer: string): string | null {
  const p = peer.trim().toLowerCase().replace(/^@/, '')
  for (const e of topicDirectory()) {
    if (e.slug === p || e.topic === p) return e.topic
  }
  return null
}

function slugForTopic(topic: string): string {
  for (const e of topicDirectory()) if (e.topic === topic) return e.slug
  return topic
}

// Deep link to a message in the square thread (private supergroup form:
// t.me/c/<chat id without -100>/<thread id>/<message id>).
function squareLink(msgId: number): string {
  const internal = String(GROUP_CHAT_ID).replace(/^-100/, '')
  return `https://t.me/c/${internal}/${SQUARE_TOPIC}/${msgId}`
}

// The standing per-delivery norm (the "pre-message hook"): conversation
// discipline is behavioral, not enforced - see the design doc. Appended to
// every square delivery's content.
function squareNorm(conv: string, replyToken: number): string {
  return (
    `[square message - NOT from your topic's user. To respond, use the square_reply tool with ` +
    `conv="${conv}" and reply_token="${replyToken}" - do NOT use the reply tool (it posts to your ` +
    `own topic, the wrong room; this message did not come from there). Reply ONLY if it moves the ` +
    `work forward; a closing courtesy is fine, courtesy-for-courtesy is not; if no reply is ` +
    `warranted, do nothing - silence politely ends a conversation here and no reply-guard will nag you.]`
  )
}

// Deliver a square message to a set of topics (recipient set = participants
// or tagged claudes, NEVER broadcast). Wakes dormant claudes (a tag counts as
// a first message).
function deliverSquare(
  recipients: string[],
  text: string,
  meta: { conv: string; reply_token: number; from: string; origin_topic: string; depth: number },
): void {
  for (const topic of recipients) {
    if (topic === SQUARE_TOPIC) continue
    ensureSession(topic)
    // NB deliberately NO chat_id / message_id keys in this meta: the channel
    // instructions train "reply via the reply tool with chat_id from the
    // inbound block", and a resumed long-lived session follows that habit
    // straight into posting square answers in its OWN topic (observed live,
    // 2026-07-17). Omitting those keys removes the affordance - the only
    // executable recipe in the meta is square_reply's (conv + reply_token),
    // and the norm line says so explicitly.
    enqueue(topic, {
      content: `${text}\n\n${squareNorm(meta.conv, meta.reply_token)}`,
      meta: {
        square: '1',
        conv: meta.conv,
        reply_token: String(meta.reply_token),
        from: meta.from,
        origin_topic: meta.origin_topic,
        depth: String(meta.depth),
        ts: new Date().toISOString(),
      },
    })
  }
}

// POST /square/tag {topic, peer, text} - open a conversation. Posts the root
// message in the square, registers the conv, breadcrumbs the caller's topic,
// delivers to (and wakes) the peer.
async function handleSquareTag(req: Request): Promise<Response> {
  if (!SQUARE_TOPIC) return new Response('square not configured', { status: 404 })
  const b = (await req.json()) as any
  const caller = String(b.topic ?? '')
  const peer = resolvePeer(String(b.peer ?? ''))
  const text = String(b.text ?? '').trim()
  if (!peer) {
    const dir = topicDirectory().map(e => e.slug).join(', ')
    return new Response(`unknown peer; known topics: ${dir}`, { status: 400 })
  }
  if (peer === caller) return new Response('cannot tag yourself', { status: 400 })
  if (!text) return new Response('text required', { status: 400 })

  // VIRTUAL CALLERS: any caller that is not a real topic ("operator", "ci",
  // future automations) renders in the header but must never become a
  // conversation participant - a participant gets deliveries, and delivery
  // calls ensureSession, which would SPAWN a claude for a topic that does
  // not exist. Real topics keep the full breadcrumb + participant behavior.
  const realTopics = new Set(topicDirectory().map(e => e.topic))
  const callerIsReal = realTopics.has(caller)
  const callerSlug = callerIsReal ? slugForTopic(caller) : caller.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'operator' 
  const peerSlug = slugForTopic(peer)
  const header = `🤖 ${callerSlug} → @${peerSlug}`
  const sent = await bot.api.sendMessage(String(GROUP_CHAT_ID), `${header}\n${text}`, {
    message_thread_id: Number(SQUARE_TOPIC),
  })
  const conv = String(sent.message_id)
  convs.set(conv, {
    participants: callerIsReal ? [...new Set([caller, peer])] : [peer],
    last_msg_id: sent.message_id,
    origin_topic: caller,
    depth: 1,
    updated_at: Date.now(),
  })
  saveConvs()

  // Breadcrumb in the caller's own room (real claude callers only), with a deep link.
  if (callerIsReal) {
    const tid = threadIdForTopic(caller)
    bot.api
      .sendMessage(String(GROUP_CHAT_ID), `↪️ asked @${peerSlug} in #square: ${squareLink(sent.message_id)}`, {
        ...(tid != null ? { message_thread_id: tid } : {}),
      })
      .catch(e => log(`breadcrumb failed for ${caller}: ${e}`))
  }

  deliverSquare([peer], `(square conversation #${conv}, opened by ${callerSlug}) ${text}`, {
    conv,
    reply_token: sent.message_id,
    from: callerSlug,
    origin_topic: caller,
    depth: 1,
  })
  log(`square: ${callerSlug} tagged ${peerSlug} -> conv ${conv}`)
  return json({ conv, message_id: sent.message_id })
}

// POST /square/reply {topic, conv, reply_token?, text} - continue a
// conversation this claude participates in. Threads under the message being
// answered (reply_token from the notification meta) or the conv root as the
// safe fallback - a stray unthreaded message is not expressible.
async function handleSquareReply(req: Request): Promise<Response> {
  if (!SQUARE_TOPIC) return new Response('square not configured', { status: 404 })
  const b = (await req.json()) as any
  const caller = String(b.topic ?? '')
  const conv = String(b.conv ?? '')
  const text = String(b.text ?? '').trim()
  const c = convs.get(conv)
  if (!c) {
    return new Response('conversation not found (expired or never existed); use square_tag to start a new one', {
      status: 404,
    })
  }
  if (caller !== 'operator' && !c.participants.includes(caller)) {
    return new Response('not a participant of this conversation; use square_tag to start your own', { status: 403 })
  }
  if (!text) return new Response('text required', { status: 400 })

  const replyToRaw = Number(b.reply_token)
  const replyTo = Number.isFinite(replyToRaw) && replyToRaw > 0 ? replyToRaw : Number(conv)
  const callerSlug = caller === 'operator' ? 'operator' : slugForTopic(caller)
  const sent = await bot.api.sendMessage(String(GROUP_CHAT_ID), `🤖 ${callerSlug} · #${conv}\n${text}`, {
    message_thread_id: Number(SQUARE_TOPIC),
    reply_parameters: { message_id: replyTo },
  })
  c.last_msg_id = sent.message_id
  c.depth += 1
  c.updated_at = Date.now()
  saveConvs()

  const recipients = c.participants.filter(t => t !== caller)
  deliverSquare(recipients, text, {
    conv,
    reply_token: sent.message_id,
    from: callerSlug,
    origin_topic: c.origin_topic,
    depth: c.depth,
  })
  log(`square: ${callerSlug} replied in conv ${conv} (depth ${c.depth})`)
  return json({ message_id: sent.message_id })
}

// POST /rate-limit {topic, error, details} - a topic-Claude's turn died on a
// plan usage limit (429), reported by the StopFailure hook. Fail the topic
// over to MODEL_FALLBACK: pin the model, kill the stalled session, and
// enqueue a nudge so the RESPAWNED session (which --resumes the same
// conversation on the new model) picks up where it left off. Without the
// nudge the respawn would sit idle: the user's message was already consumed
// by the turn that failed, so nothing would be left in the queue to trigger
// a reply.
//
// Idempotent: a repeat report for an already-failed-over topic is a no-op
// (a claude can hit the limit again mid-recovery), so a burst of hook calls
// cannot spawn a respawn loop.
async function handleRateLimit(req: Request): Promise<Response> {
  const b = (await req.json()) as any
  const topic = String(b.topic ?? '')
  if (!topic) return new Response('topic required', { status: 400 })
  const st = getTopic(topic)
  const label = st.name || topic

  if (!MODEL_FALLBACK) {
    log(`rate limit on topic ${topic} "${label}" but no fallback model configured; leaving stalled`)
    return json({ ok: false, reason: 'no fallback configured' })
  }
  if (st.fallbackModel) {
    log(`rate limit on topic ${topic} "${label}" already on fallback ${st.fallbackModel}; no action`)
    return json({ ok: true, already: st.fallbackModel })
  }

  // When may we retry the primary? Prefer the reset time the error carried
  // (exact); otherwise probe after FALLBACK_PROBE_MIN.
  const resetAt = Number(b.reset_at)
  const until =
    Number.isFinite(resetAt) && resetAt * 1000 > Date.now()
      ? resetAt * 1000
      : Date.now() + FALLBACK_PROBE_MIN * 60_000
  st.fallbackModel = MODEL_FALLBACK
  st.fallbackUntil = until
  saveRegistry()
  log(
    `rate limit on topic ${topic} "${label}": failing over ${MODEL || '(account default)'} -> ${MODEL_FALLBACK}; ` +
      `will retry primary after ${new Date(until).toISOString()}` +
      (Number.isFinite(resetAt) ? ' (reset time from the error)' : ' (probe interval; error carried no reset time)'),
  )

  // Tell the operator IN the affected topic's thread - a silent model swap
  // would leave them wondering why the voice changed mid-conversation. Sent
  // by the proxy (not the topic-Claude): the session is being killed right
  // now, so it is in no position to announce anything.
  const tid = threadIdForTopic(topic)
  bot.api
    .sendMessage(
      String(GROUP_CHAT_ID),
      `⚠️ Hit the usage limit on ${MODEL || 'the default model'} - resuming this conversation on ${MODEL_FALLBACK}. ` +
        `Will retry ${MODEL || 'the primary model'} after ${new Date(until).toLocaleTimeString()}.`,
      { ...(tid != null ? { message_thread_id: tid } : {}) },
    )
    .catch(e => log(`failover notice failed for topic ${topic}: ${e}`))

  // Kill the stalled session AND drop its stale long-polls before enqueueing:
  // otherwise the nudge is handed to the dying MCP and lost (see killSession).
  killSession(st, topic)

  enqueue(topic, {
    content:
      `SYSTEM NOTICE (not a user message): your previous turn failed because the ${MODEL || 'default'} ` +
      `usage limit was reached, so this session has been restarted on ${MODEL_FALLBACK} with your full ` +
      `conversation intact. Continue where you left off: answer the user's most recent message now. ` +
      `Mention the model switch only if it affects the answer.`,
    meta: {
      chat_id: String(GROUP_CHAT_ID),
      failover: '1',
      model: MODEL_FALLBACK,
      ts: new Date().toISOString(),
    },
  })
  ensureSession(topic)
  return json({ ok: true, model: MODEL_FALLBACK })
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
  const b = (await req.json()) as any
  const topic = String(b.topic ?? '')
  if (!topic) return new Response('topic required', { status: 400 })
  const err = String(b.error ?? 'unknown').slice(0, 40)
  const details = String(b.details ?? '')
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
  const b = (await req.json()) as any
  const name = String(b.name ?? '').trim()
  if (!name) return new Response('name required', { status: 400 })
  const created = await bot.api.createForumTopic(String(GROUP_CHAT_ID), name)
  const topic = String(created.message_thread_id)
  const st = getTopic(topic)
  st.name = name
  topicNames.set(topic, name)
  saveRegistry()
  log(`created + registered topic ${topic} "${name}"`)
  return json({ topic, thread_id: created.message_thread_id, name, slug: slugForTopic(topic) })
}

// Inbound handling for USER messages posted in the square topic. Reply-chain
// membership or an explicit @tag addresses claudes; an untagged non-reply is
// visible text delivered to no one. A human message in a conv RESETS its
// depth (human presence re-authorizes budget) and re-registers a conv lazily
// if conversations.json was lost (the self-describing "#<conv>" header in the
// replied-to message).
function handleSquareUserMessage(msg: any, text: string): void {
  const uname = msg.from?.username ?? String(msg.from?.id ?? 'operator')
  // 1. Reply within a chain?
  const parent = msg.reply_to_message
  if (parent) {
    const parentText = String(parent.text ?? '')
    let conv = convs.has(String(parent.message_id)) ? String(parent.message_id) : ''
    if (!conv) {
      const m = parentText.match(/#(\d+)/)
      if (m && convs.has(m[1])) conv = m[1]
      else if (m) {
        // Lazy rederivation: rebuild a minimal conv entry from the footer.
        conv = m[1]
        convs.set(conv, {
          participants: [],
          last_msg_id: parent.message_id,
          origin_topic: 'unknown',
          depth: 0,
          updated_at: Date.now(),
        })
        log(`square: rederived conv ${conv} from message footer`)
      }
    }
    if (conv) {
      const c = convs.get(conv)!
      // Participants may also be rederivable from the parent header (slugs).
      if (c.participants.length === 0) {
        const slugs = parentText.match(/🤖 ([a-z0-9-]+)(?: → @([a-z0-9-]+))?/)
        for (const s of [slugs?.[1], slugs?.[2]]) {
          const t = s ? resolvePeer(s) : null
          if (t) c.participants.push(t)
        }
      }
      c.depth = 0 // human message resets the budget clock
      c.last_msg_id = msg.message_id
      c.updated_at = Date.now()
      saveConvs()
      deliverSquare(c.participants, text, {
        conv,
        reply_token: msg.message_id,
        from: `operator (${uname})`,
        origin_topic: 'square',
        depth: 0,
      })
      log(`square: operator replied in conv ${conv}`)
      return
    }
  }
  // 2. Fresh @tags open new conversation(s).
  const tags = [...text.matchAll(/@([a-z0-9-]+)/gi)].map(m => m[1])
  const peers = [...new Set(tags.map(t => resolvePeer(t)).filter((t): t is string => !!t))]
  if (peers.length > 0) {
    const conv = String(msg.message_id)
    convs.set(conv, {
      participants: peers,
      last_msg_id: msg.message_id,
      origin_topic: 'square',
      depth: 0,
      updated_at: Date.now(),
    })
    saveConvs()
    deliverSquare(peers, text, {
      conv,
      reply_token: msg.message_id,
      from: `operator (${uname})`,
      origin_topic: 'square',
      depth: 0,
    })
    log(`square: operator opened conv ${conv} with ${peers.join(',')}`)
  }
  // 3. Untagged non-reply: visible text, delivered to no one.
}

// ---- spawn (single-flight) -------------------------------------------------

function kickoffPrompt(topicLabel: string): string {
  return (
    `SYSTEM STARTUP NOTICE (not a user message): you are the Claude for the ${topicLabel} topic. ` +
    `Do NOT greet or send anything yet. Wait for the first real user message - it will arrive as a ` +
    `<channel> turn - and respond to THAT via the telegram MCP (it targets this topic). Your working ` +
    `dir is ${SPAWN_DIR}. IMPORTANT: other Claudes may be running concurrently on this same machine, ` +
    `un-sandboxed and possibly in overlapping dirs, so be careful with destructive or global actions ` +
    `and with shared state, and do not assume you are alone.` +
    (SQUARE_TOPIC
      ? ` THE SQUARE: a shared #square topic hosts agent-to-agent conversations. To ask a peer Claude ` +
        `for help, use the square_tag tool (see list_topics for peers); continue conversations with ` +
        `square_reply using the conv + reply_token from the notification meta. Norms: tag a peer only ` +
        `when you genuinely need them; every message must move the work forward; do long work in shared ` +
        `files and post summaries + paths; a closing courtesy is fine but never reply to a courtesy with ` +
        `a courtesy; if a square notification warrants no reply, do nothing - silence politely ends a ` +
        `conversation and is explicitly sanctioned there (the reply requirement applies to YOUR topic's ` +
        `user messages, not square deliveries).`
      : '')
  )
}

// Drop a topic's usage-limit failover once its retry window has passed, so the
// next SPAWN uses the primary model again.
//
// Deliberately lazy - checked at spawn time, never on a timer:
//   - A topic whose session is already LIVE is left alone. Killing a running
//     Claude mid-task to upgrade its model would be a worse bug than the one
//     this feature fixes; it picks the primary up at its next natural respawn.
//   - Idle topics cost nothing to revert, matching the plugin's passive design
//     (sessions exist only when in use).
// If the quota turns out to still be exhausted, the very next turn fails over
// again - one notice, conversation continues - so probing early is cheap.
function maybeRevertFallback(st: TopicState, topic: string): void {
  if (!st.fallbackModel) return
  if (st.fallbackUntil && Date.now() < st.fallbackUntil) return
  if (st.session && mux.liveSessions().has(st.session)) return // live: leave it be
  const was = st.fallbackModel
  st.fallbackModel = undefined
  st.fallbackUntil = undefined
  saveRegistry()
  log(`topic ${topic} "${st.name}": retry window elapsed, reverting ${was} -> ${MODEL || '(account default)'}`)
  const tid = threadIdForTopic(topic)
  bot.api
    .sendMessage(
      String(GROUP_CHAT_ID),
      `✅ Usage window elapsed - back on ${MODEL || 'the default model'} for this topic.`,
      { ...(tid != null ? { message_thread_id: tid } : {}) },
    )
    .catch(e => log(`revert notice failed for topic ${topic}: ${e}`))
}

// Ensure a live tmux Claude session exists for a topic. Single-flight: the
// synchronous spawnSync blocks the event loop for the whole launch, so two
// inbound messages for a brand-new topic cannot spawn two sessions; the
// spawning flag + the live-session dedup are belt and suspenders.
function ensureSession(topic: string): void {
  // The square topic hosts conversations, not a claude of its own.
  if (SQUARE_TOPIC && topic === SQUARE_TOPIC) return
  const st = getTopic(topic)
  if (st.spawning) return
  maybeRevertFallback(st, topic)
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
    // Name the tmux session from the CURRENT label (fresh each spawn, so a rename
    // takes effect on the next respawn); recorded in st.session after a successful
    // spawn so dedup + kill target this exact string.
    const name = sessionNameFor(topic, label)
    // Regenerate the effective settings for THIS spawn so it reflects the current
    // committed base + the ultracode config (fresh on every respawn).
    const settingsPath = resolveSettings()
    const env = {
      ...process.env,
      TG_SESSION: name,
      TG_MUX: mux.kind,
      TG_SPAWN_DIR: SPAWN_DIR,
      TELEGRAM_TOPIC_ID: topic,
      TELEGRAM_PROXY_URL: PROXY_URL,
      TG_MARKETPLACE: MARKETPLACE,
      TG_SETTINGS: settingsPath,
      TG_HOOK: STOP_HOOK,
      TG_FAILOVER_HOOK: FAILOVER_HOOK,
      // A topic failed over by handleRateLimit keeps its fallback model on
      // every respawn until the nightly restart clears it.
      TG_MODEL: st.fallbackModel || MODEL,
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
    log(`${resuming ? 'resumed' : 'spawned'} topic ${topic} "${label}" (claude ${st.claudeSessionId}) -> ${mux.kind} ${name}`)
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
loadConvs()

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
            if (req.method === 'POST' && url.pathname === '/rate-limit') return await handleRateLimit(req)
            if (req.method === 'POST' && url.pathname === '/turn-failed') return await handleTurnFailed(req)
            if (req.method === 'GET' && url.pathname === '/topics') return handleTopics()
            if (req.method === 'POST' && url.pathname === '/topic/create') return await handleTopicCreate(req)
            if (req.method === 'POST' && url.pathname === '/square/tag') return await handleSquareTag(req)
            if (req.method === 'POST' && url.pathname === '/square/reply') return await handleSquareReply(req)
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
            `polling as @${info.username}; group ${GROUP_CHAT_ID}; spawn dir ${SPAWN_DIR}; marketplace ${MARKETPLACE}; ultracode ${ULTRACODE ? 'on' : 'off'}; model ${MODEL || '(account default)'}`,
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

// ---- nightly restart (passive) ---------------------------------------------
//
// If TELEGRAM_TOPICS_NIGHTLY_RESTART_HOUR is set (0-23, LOCAL time), once a day
// at that hour kill every live topic session. Each one then re-spawns with
// --resume on its NEXT inbound message (fresh claude + latest launcher config,
// full conversation kept). Passive by design: we do NOT keep idle sessions
// running - the proxy polls Telegram, the topic-Claudes don't, so they only
// need to be up when actually in use. Mirrors the single-session bridge's
// nightly restart (pick up claude updates + clear accumulated process state)
// without paying to keep refreshed-but-idle sessions alive overnight.
function nightlyRestart(): void {
  const live = mux.liveSessions()
  let killed = 0
  for (const [topic, st] of topics) {
    if (!st.session || !live.has(st.session)) continue
    if (killSession(st, topic)) {
      killed++
      log(`nightly restart: killed topic ${topic} "${st.name}"; will --resume on next message`)
    } else {
      log(`nightly restart: failed to kill topic ${topic} "${st.name}"`)
    }
  }
  // Clear every usage-limit failover: quotas reset on their own schedule, so
  // the nightly restart is when topics get to try their primary model again.
  // (A topic still over its limit simply fails over once more.)
  let reverted = 0
  for (const [topic, st] of topics) {
    if (!st.fallbackModel) continue
    log(`nightly restart: topic ${topic} "${st.name}" reverting from fallback ${st.fallbackModel} to ${MODEL || '(account default)'}`)
    st.fallbackModel = undefined
    reverted++
  }
  saveRegistry()
  log(`nightly restart complete: ${killed} topic session(s) killed, ${reverted} model failover(s) reverted`)
}

const NIGHTLY_HOUR_RAW = process.env.TELEGRAM_TOPICS_NIGHTLY_RESTART_HOUR ?? ''
if (NIGHTLY_HOUR_RAW !== '') {
  const nightlyHour = Number(NIGHTLY_HOUR_RAW)
  if (Number.isInteger(nightlyHour) && nightlyHour >= 0 && nightlyHour <= 23) {
    let lastRestartDay = ''
    // Check once a minute; fire once when the local hour first matches, deduped
    // by local date so a clock nudge cannot double-fire within the same hour.
    setInterval(() => {
      const now = new Date()
      const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
      if (now.getHours() === nightlyHour && lastRestartDay !== day) {
        lastRestartDay = day
        nightlyRestart()
      }
    }, 60_000)
    log(`nightly restart enabled: ${String(nightlyHour).padStart(2, '0')}:00 local`)
  } else {
    log(`TELEGRAM_TOPICS_NIGHTLY_RESTART_HOUR="${NIGHTLY_HOUR_RAW}" is not an integer 0-23; nightly restart disabled`)
  }
}
