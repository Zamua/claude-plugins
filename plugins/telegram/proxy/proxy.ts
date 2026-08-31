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
import { spawnSync, execFile, execFileSync } from 'child_process'
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import {
  SECRET_CMD_RE, SecretExists, SecretMissing, advanceSecretFlow, beginSecretFlow, deleteSecret, listSecrets,
  parseSecretCommand, secretExists, storeSecret,
} from './secret'
import type { FlowResult, Pending } from './secret'
import { claudeSpawnEnv } from './adapters/claude-launch'
import type { ClaudeSpawnSpec } from './adapters/claude-launch'
import { effectiveClaudeSettings } from './adapters/claude-settings'
import { catalogFromBridge, parseOpenCodeModels } from './adapters/provider-catalog'
import type { ProviderCatalog, ProviderModel } from './adapters/provider-catalog'
import { readCodexSnapshot } from './adapters/codex-app-server'
import { readOpenCodeGoCapacity } from './adapters/opencode-go-capacity'
import { createMultiplexer } from './adapters/multiplexer'
import type { MultiplexerPort } from './adapters/multiplexer'
import { legacySwitchBackTarget, switchBackTarget } from './adapters/telegram-route-callback'
import { inboundModeForRoute, renderPaneTurn } from './domain/inbound-delivery'
import type { InboundMessage } from './domain/inbound-delivery'
import {
  DEFAULT_ROUTE,
  auxiliaryModelForRoute,
  autoCompactWindow,
  exhaustedRouteFor,
  forgetExhaustedProvider,
  modelLabel,
  planRouteChange,
  providerLabel,
  rememberExhaustedRoute,
  sameRoute,
  topicRoute,
  topicRouteFromRecord,
} from './domain/model-routing'
import type {
  Effort,
  PendingRouteChange,
  ProviderId,
  RouteChangeReason,
  TopicRoute,
} from './domain/model-routing'
import { capacityTransition, nextResetAt, providerCapacity } from './domain/provider-capacity'
import type { ProviderCapacity } from './domain/provider-capacity'
import { environmentFlag } from './domain/env-flag'
import { launchProfileNeedsRefresh } from './domain/launch-profile'

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
// The StopFailure hook that reports a usage-limit stall. The proxy pauses the
// exhausted route and offers provider/model choices in Telegram; it never
// swaps providers without the operator's selection.
const FAILOVER_HOOK = join(PLUGIN_ROOT, 'hooks', 'rate-limit-failover.py')
const CAPACITY_HOOK = join(PLUGIN_ROOT, 'hooks', 'provider-capacity-status.py')
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
// Secret drop is gated on ONE user id (unset = feature off): the group gate
// alone admits every member, and this writes files into the operator's home.
const SECRETS_USER_ID = process.env.TELEGRAM_TOPICS_SECRETS_USER_ID ?? ''
const SECRETS_DIR = process.env.TELEGRAM_TOPICS_SECRETS_DIR ?? join(homedir(), 'keys')
// "/relaunch" in a topic kills that topic's agent and respawns it with the
// same provider route and conversation, freshly loading MCP servers and settings
// that a running session cannot pick up mid-flight.
const RELAUNCH_RE = /^\/relaunch(?:@\w+)?\s*$/
// A double tap lands inside the spawn window: the second request finds no
// live session, so it cannot double-spawn, but it would enqueue a second
// nudge and the fresh session would answer twice.
const RELAUNCH_DEBOUNCE_MS = 30_000
const lastRelaunch = new Map<string, number>()
const PROXY_URL = `http://localhost:${PORT}`

function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} telegram-topics-proxy: ${m}\n`)
}

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

// Provider/model routing belongs below the Claude Code harness. Every topic
// keeps one Claude UUID; a route change restarts that same session with a new
// launch profile. Anthropic is native. Codex and OpenCode Go use the loopback
// Anthropic-compatible bridge.
const ADMIN_USER_ID = (process.env.TELEGRAM_TOPICS_ADMIN_USER_ID ?? SECRETS_USER_ID).trim()
const MODEL_RE = /^\/model(?:@\w+)?(?:\s+(\S+))?\s*$/
const USAGE_RE = /^\/usage(?:@\w+)?\s*$/
const ROUTE_DEBOUNCE_MS = 10_000
const lastRouteChange = new Map<string, number>()
const PROVIDER_PROXY_URL = (
  process.env.TELEGRAM_PROVIDER_PROXY_URL ?? 'http://127.0.0.1:18765'
).replace(/\/$/, '')
const HOME_MANAGER_PROVIDER_PROXY_BIN = join(
  homedir(), '.local', 'state', 'nix', 'profiles', 'home-manager', 'home-path', 'bin', 'claude-code-proxy',
)
const PROVIDER_PROXY_BIN = process.env.TELEGRAM_PROVIDER_PROXY_BIN ??
  (existsSync(HOME_MANAGER_PROVIDER_PROXY_BIN) ? HOME_MANAGER_PROVIDER_PROXY_BIN : 'claude-code-proxy')
const OPENCODE_BIN = process.env.TELEGRAM_OPENCODE_BIN ?? 'opencode'
const OPENCODE_AUTH_FILE = process.env.TELEGRAM_OPENCODE_AUTH_FILE ??
  join(homedir(), '.local', 'share', 'opencode', 'auth.json')
const CAPACITY_POLL_MS = Number(process.env.TELEGRAM_PROVIDER_CAPACITY_POLL_MINUTES ?? '5') * 60_000
const DEFAULT_TOPIC_ROUTE = topicRoute({
  provider: 'anthropic',
  model: MODEL || DEFAULT_ROUTE.model,
  effort: 'xhigh',
  ultracode: false,
})

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
const EFFECTIVE_SETTINGS_DIR = join(STATE_DIR, 'effective-settings')
// Persisted with every successful topic launch. Increment whenever launch-time
// behavior changes in a way an already-running pane cannot absorb. A stale
// pane is reconciled at its next safe turn boundary, preserving its UUID.
const TOPIC_LAUNCH_PROFILE_VERSION = 2
// Called PER SPAWN (not once at module load) so each (re)spawn reflects the
// CURRENT committed override-settings.json - a base-settings edit (e.g. a git
// pull) then reaches topics on their next respawn (the nightly restart, a kill),
// matching the pre-generation behavior where spawns read the base file live. Also
// self-heals if the generated file is removed. On any read/write error it falls
// back to the committed base un-generated (topics still spawn, just without the
// ultracode override).
function resolveSettings(topic: string, route: TopicRoute): string {
  try {
    mkdirSync(EFFECTIVE_SETTINGS_DIR, { recursive: true, mode: 0o700 })
    const base = JSON.parse(readFileSync(OVERRIDE_SETTINGS, 'utf8'))
    const settings = effectiveClaudeSettings(base, route)
    const safeTopic = topic.replace(/[^a-zA-Z0-9_-]/g, '_')
    const settingsPath = join(EFFECTIVE_SETTINGS_DIR, `${safeTopic}.json`)
    // NB the MODEL is NOT baked in here: a settings `model` is only a default and
    // is ignored by a --resume'd interactive session. The launcher passes MODEL as
    // the --model FLAG (via TG_MODEL) instead, which overrides even on resume.
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
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

type InboundMsg = InboundMessage
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
  // The provider/model/effort used when this Claude session starts or resumes.
  // This is routing state, not a harness choice: every route runs Claude Code.
  route?: TopicRoute
  // Which launch-time environment/settings contract the live pane received.
  // Missing means the pane predates versioned launch profiles.
  launchProfileVersion?: number
  // A proactive switch requested while Claude is inside a turn. It is applied
  // by the next /poll, which is the observable safe turn boundary.
  pendingRoute?: PendingRouteChange
  // The latest route that exhausted quota for each provider. A conversation
  // can cross several exhausted providers; retain each exact return route so
  // every reset can offer a switch-back button.
  exhaustedRoutes: TopicRoute[]
  // One-time durable notice used by migrations and failed-turn recovery. It is
  // removed only when a resumed Claude actually polls and receives it.
  pendingResumeNotice?: string
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

// The mux session name. Readable: `<prefix>-<slug>-<thread_id>` (e.g.
// `claude-hostthis-34`), with the numeric thread id as a short, stable,
// collision-proof suffix; the General topic (no thread id) is just
// `<prefix>-general`. The prefix doubles as the harness marker
// (`claude-` / `oc-`) so panes are self-describing. Computed from the topic's
// LABEL at spawn time and then RECORDED in st.session (dedup/kill use the
// recorded string, never re-derive) so a later rename can't orphan the
// running session.
function sessionNameFor(topic: string, label?: string, prefix = 'claude'): string {
  if (topic === 'general') return `${prefix}-general`
  const id = topic.replace(/[^A-Za-z0-9]/g, '')
  const slug = slugify(label ?? '')
  // Unknown/degenerate name (the label fell back to the numeric id, or slugified
  // to the 'topic' placeholder) -> just `<prefix>-<id>`, not `<prefix>-<id>-<id>`.
  if (slug === id || slug === 'topic') return `${prefix}-${id}`
  return `${prefix}-${slug}-${id}`
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
      exhaustedRoutes: [],
    }
    topics.set(topic, st)
  }
  return st
}

function enqueue(topic: string, msg: InboundMsg): void {
  const st = getTopic(topic)
  if (inboundModeForRoute(currentRoute(st)) === 'pane') {
    // A proxied Claude runs under API billing, where Claude Code deliberately
    // disables Channels. Never hand its message to a stale /poll waiter: the
    // harness would silently discard it. Queue it for the foreground-pane
    // adapter instead.
    while (st.waiters.length) st.waiters.shift()?.(null)
    st.queue.push(msg)
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

// ---- multiplexer port -------------------------------------------------------
//
// The domain/application code depends only on this port. Concrete tmux and
// herdr process control lives in adapters/multiplexer.ts.

const mux: MultiplexerPort = createMultiplexer(MUX_KIND)

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

// ---- registry --------------------------------------------------------------

type RegistryEntry = {
  tmux_session: string
  thread_id: number | null
  name: string
  spawned_at: number
  claude_session_id: string | null
  route?: TopicRoute | null
  launch_profile_version?: number | null
  pending_route?: PendingRouteChange | null
  exhausted_routes?: TopicRoute[] | null
  pending_resume_notice?: string | null
}

function parseRoute(value: unknown): TopicRoute | undefined {
  return topicRouteFromRecord(value)
}

function routeFromRegistry(value: unknown, fallback = DEFAULT_TOPIC_ROUTE): TopicRoute {
  return parseRoute(value) ?? fallback
}

function pendingRouteFromRegistry(value: unknown): PendingRouteChange | undefined {
  const raw = value as any
  if (!raw || !['manual', 'quota', 'reset', 'migration'].includes(raw.reason)) return undefined
  const route = parseRoute(raw.route)
  if (!route) return undefined
  return {
    route,
    reason: raw.reason,
    requestedAt: Number(raw.requestedAt) || Date.now(),
  }
}

function saveRegistry(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const out: Record<string, RegistryEntry> = {}
  for (const [topic, st] of topics) {
    // Persist any topic that has been spawned at least once (has a Claude
    // session id, needed to resume the SAME conversation on the next
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
      route: st.route ?? DEFAULT_TOPIC_ROUTE,
      ...(st.launchProfileVersion !== undefined
        ? { launch_profile_version: st.launchProfileVersion }
        : {}),
      ...(st.pendingRoute ? { pending_route: st.pendingRoute } : {}),
      ...(st.exhaustedRoutes.length ? { exhausted_routes: st.exhaustedRoutes } : {}),
      ...(st.pendingResumeNotice ? { pending_resume_notice: st.pendingResumeNotice } : {}),
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
    st.route = routeFromRegistry(entry.route)
    st.launchProfileVersion = entry.launch_profile_version ?? undefined
    st.pendingRoute = pendingRouteFromRegistry(entry.pending_route)
    st.exhaustedRoutes = Array.isArray(entry.exhausted_routes)
      ? entry.exhausted_routes.flatMap(route => {
          const parsed = parseRoute(route)
          return parsed ? [parsed] : []
        })
      : []
    st.pendingResumeNotice = entry.pending_resume_notice ?? undefined
    if (entry.name) topicNames.set(topic, entry.name)
    if (entry.tmux_session && live.has(entry.tmux_session)) {
      st.session = entry.tmux_session
      st.spawnedAt = entry.spawned_at
      const refresh = launchProfileNeedsRefresh(
        st.launchProfileVersion,
        TOPIC_LAUNCH_PROFILE_VERSION,
        entry.route,
        st.route,
      )
      if (refresh && !st.pendingRoute) {
        st.pendingRoute = {
          route: st.route,
          reason: 'migration',
          requestedAt: Date.now(),
        }
        log(
          `live topic ${topic} "${entry.name}" has a stale launch profile; ` +
          `queued same-UUID refresh at the next safe turn boundary`,
        )
      } else {
        log(`re-adopted live topic ${topic} "${entry.name}" (${entry.tmux_session})`)
      }
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

// POST /rate-limit {topic, error, details, reset_at}. The failed user turn is
// already in Claude's transcript. Stop the exhausted route and let Telegram
// offer another provider; after the operator chooses one, the same Claude UUID
// resumes and receives a one-time nudge to finish that turn.
async function handleRateLimit(req: Request): Promise<Response> {
  const b = (await req.json()) as any
  const topic = String(b.topic ?? '')
  if (!topic) return new Response('topic required', { status: 400 })
  const st = getTopic(topic)
  const label = st.name || topic
  const exhaustedRoute = st.route ?? DEFAULT_TOPIC_ROUTE
  const alreadyReported = exhaustedRouteFor(st.exhaustedRoutes, exhaustedRoute.provider)
  if (!st.session && alreadyReported && sameRoute(alreadyReported, exhaustedRoute)) {
    return json({ ok: true, provider: exhaustedRoute.provider, awaiting_selection: true, duplicate: true })
  }
  const resetAt = Number(b.reset_at)
  const resetMs = Number.isFinite(resetAt) && resetAt * 1000 > Date.now()
    ? resetAt * 1000
    : undefined
  observeCapacity(providerCapacity(exhaustedRoute.provider, [{
    name: 'current window',
    usedPercent: 100,
    availability: 'exhausted',
    ...(resetMs ? { resetsAt: resetMs } : {}),
  }], Date.now()))
  st.exhaustedRoutes = rememberExhaustedRoute(st.exhaustedRoutes, exhaustedRoute)
  st.pendingRoute = undefined
  killSession(st, topic)
  saveRegistry()
  log(`rate limit on topic ${topic} "${label}" for ${exhaustedRoute.provider}/${exhaustedRoute.model}`)
  await sendProviderPicker(
    String(GROUP_CHAT_ID),
    topic,
    'quota',
    `${providerLabel(exhaustedRoute.provider)} · ${modelLabel(exhaustedRoute.model)} reached its usage limit.` +
      (resetMs ? `\nExpected reset: ${formatTime(resetMs)}.` : '') +
      `\n\nContinue this same Claude session with:`,
    exhaustedRoute.provider,
  )
  return json({ ok: true, provider: exhaustedRoute.provider, awaiting_selection: true })
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

// Ensure a live Claude Code session exists for a topic. Single-flight: the synchronous
// spawnSync blocks the event loop for the whole launch, so two inbound
// messages for a brand-new topic cannot spawn two sessions; the spawning
// flag + the live-session dedup are belt and suspenders.
function ensureSession(topic: string): void {
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
  st.spawning = true
  try {
    const label = st.name || topicNames.get(topic) || topic
    st.name = label
    const resuming = !!st.claudeSessionId
    if (!st.claudeSessionId) st.claudeSessionId = crypto.randomUUID()
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
      claudeSessionId: st.claudeSessionId ?? '',
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

// ---- voice transcription ---------------------------------------------------
//
// Inbound voice notes are transcribed locally (whisper.cpp + large-v3-turbo)
// and delivered as text behind a short provenance tag, so a topic-Claude gets
// the words as if typed. Fail-open by design: any missing binary/model or a
// transcription error falls back to the plain "(voice message)" content with
// the attachment meta intact, so the manual download path still works.
// Subprocesses run ASYNC (execFile, not spawnSync): a long clip must not
// stall the event loop that serves every topic's /poll.
const VOICE_TRANSCRIBE = environmentFlag(
  process.env.TELEGRAM_TOPICS_VOICE_TRANSCRIBE,
  true,
  (value) => log(`TELEGRAM_TOPICS_VOICE_TRANSCRIBE="${value}" is not a recognized boolean; using default (true)`),
)
const FFMPEG_BIN = process.env.TELEGRAM_TOPICS_FFMPEG_BIN ?? '/opt/homebrew/bin/ffmpeg'
const WHISPER_BIN = process.env.TELEGRAM_TOPICS_WHISPER_BIN ?? '/opt/homebrew/bin/whisper-cli'
const WHISPER_MODEL = process.env.TELEGRAM_TOPICS_WHISPER_MODEL
  ?? join(homedir(), '.local/share/whisper-models/ggml-large-v3-turbo-q5_0.bin')
const VOICE_TAG = '[voice note, auto-transcribed; may contain errors]'

// Vocabulary bias for the decoder. Whisper conditions on this text, so naming
// the stack's jargon fixes the words a general model reliably mangles:
// measured on synthesized speech, "kubectl"->"cubectal", "traefik"->"Trifik",
// "502"->"500 too", "namespace"->"namaspace". The glossary fixed most of them
// with no model change. Keep it SHORT - whisper's prompt window is ~224
// tokens, and a bloated list dilutes the bias rather than sharpening it.
// A bare word list is NOT enough for terms whose spoken form differs from the
// written one: "CLAUDE.md" is said "claude dot em dee", and listing the token
// alone still produced "clot md". Embedding the term in a natural SENTENCE
// fixed it, so the prompt ends with prose, not just commas.
const VOICE_GLOSSARY = process.env.TELEGRAM_TOPICS_WHISPER_PROMPT ?? (
  [
    'e2e', 'CI', 'PR', 'repo', 'staging', 'prod', 'semver', 'ghcr', 'MCP', 'API',
    'transcription', 'glossary', 'CLI', 'JSON', 'YAML', 'regex', 'ripgrep',
    'async', 'await', 'TODO', 'kubectl', 'namespace', 'k3s', 'traefik', 'nginx',
    'MinIO', 'podman', 'colima', 'tmux', 'launchd', 'pm2', 'caddy', 'tailscale',
    'herdr', 'PostgreSQL', 'SQLite', 'slatedb', 'Hetzner', 'Oracle',
    'Cloudflare', 'OpenTofu', 'ansible', 'prepcards',
    'boardtogether', 'pokerchips', 'jamshelf', 'shale', 'whisper',
    'Claude', 'opus', 'sonnet', 'fable',
  ].join(', ')
  // Terms whose SPOKEN form differs from the written one need a sentence, not a
  // list entry: "hostthis" is said "host this" and came back as "hostess" while
  // sitting in the list above, and "celld" is said "cell dee".
  + '. Update the CLAUDE.md file, run the e2e tests, then check the CI logs.'
  + ' Deploy hostthis to staging, then migrate hostthis onto celld and check the celld cells.'
)

function run(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

async function transcribeVoice(fileId: string): Promise<string | null> {
  if (!VOICE_TRANSCRIBE) return null
  for (const [what, p] of [['ffmpeg', FFMPEG_BIN], ['whisper-cli', WHISPER_BIN], ['model', WHISPER_MODEL]] as const) {
    if (!existsSync(p)) {
      log(`voice transcription skipped: ${what} not found at ${p}`)
      return null
    }
  }
  const oga = await downloadFile(fileId)
  if (!oga) return null
  const wav = `${oga}.16k.wav`
  try {
    const ff = await run(FFMPEG_BIN, ['-y', '-v', 'error', '-i', oga, '-ar', '16000', '-ac', '1', wav], 30_000)
    if (ff === null) {
      log('voice transcription: ffmpeg failed')
      return null
    }
    const whisperArgs = ['-m', WHISPER_MODEL, '-f', wav, '--no-timestamps']
    if (VOICE_GLOSSARY.trim()) whisperArgs.push('--prompt', VOICE_GLOSSARY)
    const out = await run(WHISPER_BIN, whisperArgs, 120_000)
    if (out === null) {
      log('voice transcription: whisper-cli failed')
      return null
    }
    const text = out.trim()
    return text || null
  } finally {
    for (const f of [wav, oga]) {
      try { rmSync(f) } catch {}
    }
  }
}

// ---- grammy inbound --------------------------------------------------------

const bot = new Bot(TOKEN)

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
    bot.api
      .sendMessage(chatId, t, topic === 'general' ? {} : { message_thread_id: Number(topic) })
      .catch(() => {})
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
  if (SQUARE_TOPIC && topic === SQUARE_TOPIC) return
  ensureSession(topic)
  enqueue(topic, {
    content: `SYSTEM NOTICE (not a user message): ${what} No reply is required.`,
    meta: {
      chat_id: chatId,
      user: 'telegram-topics-proxy',
      user_id: fromId,
      ts: new Date().toISOString(),
      ...(topic !== 'general' ? { message_thread_id: topic } : {}),
      secret_drop: '1',
    },
  })
}

const threadOf = (topic: string) => (topic === 'general' ? {} : { message_thread_id: Number(topic) })
const sayIn = (chatId: string, topic: string, t: string) =>
  bot.api.sendMessage(chatId, t, threadOf(topic)).catch(() => {})
const tilde = (p: string) => (p.startsWith(homedir() + sep) ? '~' + p.slice(homedir().length) : p)
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Same kill-then-nudge sequence as a provider-route recovery: killSession
// drains the dying MCP's long-polls first so the nudge cannot be handed to it
// and lost. The nudge asks for one line back, so a respawn that fails is a
// visible silence rather than a quiet one.
async function handleRelaunch(chatId: string, topic: string, fromId: string): Promise<void> {
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
  log(`relaunch of topic ${topic} "${st.name || topic}" requested by user ${fromId} (was ${wasLive ? 'live' : 'not running'})`)
  await sayIn(
    chatId, topic,
    `♻️ relaunching this topic's agent${wasLive ? '' : ' (it was not running)'}: same conversation, ` +
      'freshly loaded MCP servers and settings.',
  )
  enqueue(topic, {
    content:
      'SYSTEM NOTICE (not a user message): the operator relaunched this session, so it has just restarted ' +
      'with your full conversation intact and freshly loaded MCP servers and settings. Reply with ONE short ' +
      'line confirming you are back and naming the MCP servers you now see, then continue any pending work.',
    meta: {
      chat_id: chatId,
      user: 'telegram-topics-proxy',
      user_id: fromId,
      ts: new Date().toISOString(),
      ...(topic !== 'general' ? { message_thread_id: topic } : {}),
      relaunch: '1',
    },
  })
  ensureSession(topic)
}

// ---- provider routing application service + Telegram adapter ---------------

const capacities = new Map<ProviderId, ProviderCapacity>()
type PickerReason = 'manual' | 'quota' | 'reset'
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

const providerCode = (provider: ProviderId): string =>
  provider === 'anthropic' ? 'a' : provider === 'codex' ? 'c' : 'o'
const providerFromCode = (code: string): ProviderId | undefined =>
  code === 'a' ? 'anthropic' : code === 'c' ? 'codex' : code === 'o' ? 'opencode-go' : undefined
const reasonCode = (reason: PickerReason): string => reason === 'manual' ? 'm' : reason === 'quota' ? 'q' : 'r'
const reasonFromCode = (code: string): PickerReason | undefined =>
  code === 'm' ? 'manual' : code === 'q' ? 'quota' : code === 'r' ? 'reset' : undefined

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
    const output = execFileSync(OPENCODE_BIN, ['models', 'opencode-go', '--verbose'], {
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
    keyboard.text(`${providerLabel(provider)}${suffix}`, `tgroute:p:${providerCode(provider)}:${reasonCode(reason)}:${topic}`).row()
  }
  keyboard.text('Usage', `tgroute:usage:${topic}`)
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
    keyboard.text(`${model.label}${model.bridgeSupported === false ? ' · bridge update needed' : ''}`, `tgroute:m:${token}`).row()
  }
  if (pages > 1) {
    if (safePage > 0) {
      keyboard.text('Previous', `tgroute:models:${providerCode(provider)}:${reasonCode(reason)}:${topic}:${safePage - 1}`)
    }
    if (safePage + 1 < pages) {
      keyboard.text('Next', `tgroute:models:${providerCode(provider)}:${reasonCode(reason)}:${topic}:${safePage + 1}`)
    }
    keyboard.row()
  }
  keyboard.text('Back', `tgroute:providers:${reasonCode(reason)}:${topic}`)
  return {
    text: models.length
      ? `${providerLabel(provider)} models${pages > 1 ? ` (${safePage + 1}/${pages})` : ''}:`
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
    `reached its usage limit. This same Claude Code session has resumed through ${providerLabel(to.provider)} ` +
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
  if (reason === 'reset' || exhaustedRouteFor(st.exhaustedRoutes, route.provider)) {
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
    await bot.api.sendMessage(chatId, picker.text, { ...threadOf(topic), reply_markup: picker.keyboard }).catch(() => {})
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
    .text(`Switch back to ${modelLabel(route.model)}`, `tgroute:return:${providerCode(route.provider)}:${topic}`)
    .row()
    .text(`Choose ${providerLabel(route.provider)} model`, `tgroute:p:${providerCode(route.provider)}:r:${topic}`)
    .row()
    .text('Dismiss', 'tgroute:dismiss')
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
  await ctx.editMessageText(text).catch((error: unknown) =>
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
    readOpenCodeGoCapacity(OPENCODE_AUTH_FILE),
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

  // Secret drop runs before every relay path, the square included, so the
  // value can reach neither a topic-Claude nor a peer. See handleSecretDrop.
  if (typeof msg.text === 'string' && SECRET_CMD_RE.test(msg.text)) {
    await handleSecretDrop(String(ctx.chat.id), topic, msg.message_id, String(ctx.from?.id ?? ''), msg.text)
    return
  }
  if (typeof msg.text === 'string' && RELAUNCH_RE.test(msg.text)) {
    await handleRelaunch(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''))
    return
  }
  const modelMatch = MODEL_RE.exec(msg.text ?? '')
  if (modelMatch) {
    await handleModelCommand(String(ctx.chat.id), topic, String(ctx.from?.id ?? ''), modelMatch[1] ?? '')
    return
  }
  if (USAGE_RE.test(msg.text ?? '')) {
    if (!ADMIN_USER_ID || String(ctx.from?.id ?? '') !== ADMIN_USER_ID) {
      await sayIn(String(ctx.chat.id), topic, 'Only the operator can inspect provider usage.')
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

  let voiceTranscribed = false
  if (desc.attachment?.kind === 'voice') {
    const text = await transcribeVoice(desc.attachment.file_id)
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
    const cbChatId = ctx.callbackQuery.message?.chat.id
    const fromId = String(ctx.callbackQuery.from.id)
    if (String(cbChatId) !== String(GROUP_CHAT_ID) || !ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }

    const returnPick = switchBackTarget(data)
    if (returnPick) {
      await applySwitchBackCallback(ctx, returnPick.provider, returnPick.topic)
      return
    }

    const providerPick = /^tgroute:p:([aco]):([mqr]):(.+)$/.exec(data)
    const pagePick = /^tgroute:models:([aco]):([mqr]):([^:]+):(\d+)$/.exec(data)
    if (providerPick || pagePick) {
      const match = providerPick ?? pagePick!
      const provider = providerFromCode(match[1])
      const reason = reasonFromCode(match[2])
      const topic = match[3]
      const page = pagePick ? Number(match[4]) : 0
      if (!provider || !reason) {
        await ctx.answerCallbackQuery({ text: 'This picker is no longer valid.' }).catch(() => {})
        return
      }
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

    const back = /^tgroute:providers:([mqr]):(.+)$/.exec(data)
    if (back) {
      const reason = reasonFromCode(back[1])
      const topic = back[2]
      if (!reason) return
      const st = getTopic(topic)
      const exclude = reason === 'quota' ? st.exhaustedRoutes.at(-1)?.provider : undefined
      await ctx.editMessageText('Choose a provider:', {
        reply_markup: providerKeyboard(topic, reason, exclude),
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    const modelPick = /^tgroute:m:([a-f0-9]+)$/.exec(data)
    if (modelPick) {
      pruneModelSelections()
      const selection = modelSelections.get(modelPick[1])
      if (!selection) {
        const legacy = legacySwitchBackTarget(ctx.callbackQuery.message)
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
        keyboard.text(`${label}${suffix}`, `tgroute:e:${modelPick[1]}:${effort}`).row()
      }
      await ctx.editMessageText(`${selection.model.label}: choose reasoning effort`, {
        reply_markup: keyboard,
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    const effortPick = /^tgroute:e:([a-f0-9]+):(auto|low|medium|high|xhigh|max)$/.exec(data)
    if (effortPick) {
      pruneModelSelections()
      const selection = modelSelections.get(effortPick[1])
      const effort = effortPick[2] as Effort
      if (!selection || !selection.model.efforts.includes(effort)) {
        await ctx.answerCallbackQuery({ text: 'This effort picker expired.' }).catch(() => {})
        return
      }
      selection.effort = effort
      const keyboard = new InlineKeyboard().text('Off', `tgroute:u:${effortPick[1]}:0`).row()
      if (selection.model.supportsUltracode) {
        keyboard.text('On · forces xhigh + workflows', `tgroute:u:${effortPick[1]}:1`).row()
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

    const ultracodePick = /^tgroute:u:([a-f0-9]+):([01])$/.exec(data)
    if (ultracodePick) {
      pruneModelSelections()
      const selection = modelSelections.get(ultracodePick[1])
      const ultracode = ultracodePick[2] === '1'
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
      modelSelections.delete(ultracodePick[1])
      await ctx.editMessageText(
        result === 'queued'
          ? `Queued ${routeSummary(route)}. It will switch when the current Claude turn finishes.`
          : result === 'unchanged'
            ? `Already using ${routeSummary(route)}.`
            : `Now using ${routeSummary(route)} in the same Claude session.`,
      ).catch(() => {})
      await ctx.answerCallbackQuery({ text: result === 'queued' ? 'Switch queued.' : 'Route updated.' }).catch(() => {})
      return
    }

    const usagePick = /^tgroute:usage:(.+)$/.exec(data)
    if (usagePick) {
      await refreshProviderCapacity()
      await ctx.editMessageText(capacityText(), {
        reply_markup: new InlineKeyboard().text('Back', `tgroute:providers:m:${usagePick[1]}`),
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (data === 'tgroute:dismiss') {
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
if (Number.isFinite(CAPACITY_POLL_MS) && CAPACITY_POLL_MS >= 60_000) {
  setInterval(() => void refreshProviderCapacity(), CAPACITY_POLL_MS)
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
            if (req.method === 'POST' && url.pathname === '/capacity') return await handleCapacity(req)
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
  saveRegistry()
  log(`nightly restart complete: ${killed} topic session(s) killed; provider routes preserved`)
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
