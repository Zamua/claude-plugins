// The proxy's configuration: paths, the .env files loaded into the environment,
// and every setting read from it. Importing this module loads the .env files.
import { chmodSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { DEFAULT_MODEL, DEFAULT_ROUTE, topicRoute } from './domain/model-routing'
import { log } from './log'

// ---- paths -----------------------------------------------------------------

export const PLUGIN_ROOT = join(import.meta.dir, '..')
export const STATE_DIR =
  process.env.TELEGRAM_TOPICS_STATE_DIR ??
  join(homedir(), '.claude', 'channels', 'telegram-topics')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const REGISTRY_FILE = join(STATE_DIR, 'registry.json')
export const PID_FILE = join(STATE_DIR, 'proxy.pid')
export const OVERRIDE_SETTINGS = join(PLUGIN_ROOT, 'override-settings.json')
// The Stop hook that keeps replies out of the transcript. override-settings.json
// references it as $TG_HOOK (passed to the session via `tmux new-session -e`) so
// that committed file needs no hardcoded path.
export const STOP_HOOK = join(PLUGIN_ROOT, 'hooks', 'stop-reply-guard.py')
// The StopFailure hook that reports a usage-limit stall. A Fable limit falls
// back to Opus automatically; any other limit pauses the route and offers
// provider/model choices in Telegram.
export const FAILOVER_HOOK = join(PLUGIN_ROOT, 'hooks', 'rate-limit-failover.py')
export const CAPACITY_HOOK = join(PLUGIN_ROOT, 'hooks', 'provider-capacity-status.py')
export const ANTIGRAVITY_TOPICS_FILE = join(STATE_DIR, 'antigravity-topics.json')
export const LAUNCH_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'launch-topic.sh')
export const HERDR_LAUNCH_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'launch-herdr-topic.sh')
export const OPENCODE_TOPICS_FILE = join(STATE_DIR, 'opencode-topics.json')
export const LOCALGEN_TOPICS_FILE = join(STATE_DIR, 'localgen-topics.json')
export const REMINDERS_FILE = join(STATE_DIR, 'reminders.json')
// The token-bearing .env files. assertSendable refuses to ship these so a
// prompt-injected topic-Claude cannot exfil the bot token via reply(files:[...]).
export const ENV_FILES = [join(PLUGIN_ROOT, '.env'), join(STATE_DIR, '.env')]

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

export const TOKEN = process.env.TELEGRAM_BOT_TOKEN
// A stand-in Bot API for the end-to-end tests; unset, grammy talks to Telegram.
export const BOT_API_ROOT = process.env.TELEGRAM_BOT_API_ROOT || undefined
export const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID
export const SPAWN_DIR = process.env.TELEGRAM_TOPICS_SPAWN_DIR ?? homedir()
export const PORT = parseInt(process.env.TELEGRAM_PROXY_PORT ?? '8790', 10)
export const MARKETPLACE = process.env.TELEGRAM_TOPICS_MARKETPLACE ?? 'plugin:telegram@zamua'
// Secret drop is gated on ONE user id (unset = feature off): the group gate
// alone admits every member, and this writes files into the operator's home.
export const SECRETS_USER_ID = process.env.TELEGRAM_TOPICS_SECRETS_USER_ID ?? ''
export const SECRETS_DIR = process.env.TELEGRAM_TOPICS_SECRETS_DIR ?? join(homedir(), 'keys')
// Default model for every topic-Claude, passed to the launcher (TG_MODEL) as the
// `--model` FLAG. NOT a settings `model` key: that is only a DEFAULT and is
// IGNORED by a --resume'd interactive session (it restores its own baked-in
// model), so an existing topic would keep its old model forever; the --model flag
// overrides even on resume (verified end-to-end). Defaults to DEFAULT_MODEL;
// TELEGRAM_TOPICS_MODEL=<id> pins another model, and `default`/`inherit`/empty
// leaves it unset so the account default applies. (The single-session bridge
// chooses its own model separately - this is topic-Claudes only.)
function resolveModel(): string {
  const raw = process.env.TELEGRAM_TOPICS_MODEL
  if (raw === undefined) return DEFAULT_MODEL
  const s = raw.trim()
  if (s === '' || s.toLowerCase() === 'default' || s.toLowerCase() === 'inherit') return ''
  return s
}
export const MODEL = resolveModel()

// Provider/model routing belongs below the Claude Code harness. Every topic
// keeps one Claude UUID; a route change restarts that same session with a new
// launch profile. Anthropic is native. Codex and OpenCode Go use the loopback
// Anthropic-compatible bridge.
export const ADMIN_USER_ID = (process.env.TELEGRAM_TOPICS_ADMIN_USER_ID ?? SECRETS_USER_ID).trim()
export const PROVIDER_PROXY_URL = (
  process.env.TELEGRAM_PROVIDER_PROXY_URL ?? 'http://127.0.0.1:18765'
).replace(/\/$/, '')
const NIX_PROFILE_BIN = join(
  '/etc', 'profiles', 'per-user', process.env.USER ?? homedir().split(sep).at(-1) ?? 'zamua', 'bin',
)
// Match the service launcher: the old standalone Home Manager profile can be stale.
const NIX_PROVIDER_PROXY_BIN = join(NIX_PROFILE_BIN, 'claude-code-proxy')
export const PROVIDER_PROXY_BIN = process.env.TELEGRAM_PROVIDER_PROXY_BIN ||
  (existsSync(NIX_PROVIDER_PROXY_BIN) ? NIX_PROVIDER_PROXY_BIN : 'claude-code-proxy')
// Shared by the OpenCode Go model catalog and the harness-locked localcode topics.
const BREW_OPENCODE_BIN = '/opt/homebrew/bin/opencode'
// `||`, not `??`: a copied .env.example leaves these as empty strings.
export const OPENCODE_BIN = process.env.TELEGRAM_OPENCODE_BIN ||
  (existsSync(BREW_OPENCODE_BIN) ? BREW_OPENCODE_BIN : 'opencode')
export const OPENCODE_GO_KEY_FILE = process.env.TELEGRAM_OPENCODE_GO_KEY_FILE ||
  join(homedir(), 'keys', 'opencode-go-key')
export const OPENCODE_PROJECT_DIR = process.env.TELEGRAM_OPENCODE_PROJECT_DIR ||
  join(homedir(), 'Dropbox', 'workspace', 'macmini', 'gpu', 'qwen-opencode')
export const OPENCODE_MODEL = process.env.TELEGRAM_OPENCODE_MODEL || 'qwen-local/Qwen3.8-27B'
// The qwen-image server: OpenAI Images API on loopback, never any agent.
export const LOCALGEN_URL = `http://127.0.0.1:${process.env.LOCALGEN_PORT || '8012'}`
export const LOCALGEN_START_CMD = process.env.TELEGRAM_LOCALGEN_START_CMD ||
  'start the qwen-image server (set TELEGRAM_LOCALGEN_START_CMD to show the exact command here)'
const NIX_ANTIGRAVITY_BIN = join(NIX_PROFILE_BIN, 'agy')
// Off: nothing runs agy. Locked topics answer with the disabled message instead.
export const ANTIGRAVITY_ENABLED = process.env.TELEGRAM_ANTIGRAVITY !== 'off'
export const ANTIGRAVITY_BIN = process.env.TELEGRAM_ANTIGRAVITY_BIN ??
  (existsSync(NIX_ANTIGRAVITY_BIN) ? NIX_ANTIGRAVITY_BIN : 'agy')
export const CAPACITY_POLL_MS = Number(process.env.TELEGRAM_PROVIDER_CAPACITY_POLL_MINUTES ?? '5') * 60_000
export const DEFAULT_TOPIC_ROUTE = topicRoute({
  provider: 'anthropic',
  model: MODEL || DEFAULT_ROUTE.model,
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
export const MUX_KIND = resolveMux()

export const PROXY_URL = `http://localhost:${PORT}`

// ---- the square (inter-Claude collaboration) --------------------------------
// One designated forum topic hosts ALL agent-to-agent conversations (design:
// "private rooms + one commons"). Empty/unset = the square is disabled and
// every square endpoint 404s. The topic is identified by thread id, created
// once by the operator (or the bot - it has can_manage_topics).
export const SQUARE_TOPIC = (process.env.TELEGRAM_TOPICS_SQUARE_TOPIC_ID ?? '').trim()
// Idle conversations are pruned from the ROUTING registry after this many
// hours (the Telegram thread itself stays readable forever - closing only
// stops routing). No hop caps / rate limits by design: discipline is the
// per-delivery norm line; Telegram's per-group limits are the only throttle.
export const CONV_TTL_HOURS = Number(process.env.TELEGRAM_TOPICS_CONV_TTL_HOURS ?? '48')
export const EFFECTIVE_SETTINGS_DIR = join(STATE_DIR, 'effective-settings')
// Persisted with every successful topic launch. Increment whenever launch-time
// behavior changes in a way an already-running pane cannot absorb. A stale
// pane is reconciled at its next safe turn boundary, preserving its UUID.
export const TOPIC_LAUNCH_PROFILE_VERSION = 4
