#!/usr/bin/env bun
/**
 * opencode-driver.ts: the pane process for an opencode telegram topic.
 *
 * The opencode analog of server.ts's inbound loop (plus the foreground REPL
 * role the claude TUI plays). It is a plain client of the proxy's HTTP
 * contract - the proxy owns the bot token and the queues, unchanged:
 *
 *   INBOUND   long-poll GET {PROXY}/poll?topic={TOPIC} (same semantics as
 *             server.ts), render each message as the SAME <channel> block a
 *             claude topic receives, and feed it to `opencode run`.
 *   SESSION   one opencode session per topic, forever. The FIRST run mints it
 *             (no -s; the proxy's seed or kickoff initializes it), the session
 *             id is POSTed to the proxy (/oc-session) for the registry, and
 *             every later run (and every respawn of this driver) continues it
 *             with -s <id>.
 *   OUTBOUND  nothing here - the telegram MCP (server.ts, outbound-only mode)
 *             provides reply/react/edit/download to the opencode agent; it is
 *             loaded from the machine's opencode config and inherits the env
 *             this driver exports (spike-verified).
 *   BACKSTOP  the claude-only Stop hook has no opencode equivalent, so the
 *             driver fills that role: if a run produced text but the topic's
 *             last-reply marker did not move, the driver POSTs the run's final
 *             text to /send itself. A reply that made it out through the MCP
 *             moves the marker; a stranded one is rescued here.
 *
 * Env (set by launch-topic.sh via the backend's spawnEnv):
 *   TELEGRAM_TOPIC_ID / TELEGRAM_PROXY_URL   as for server.ts
 *   TG_OC_SESSION_ID   '' = mint on first run; else resume this id
 *   TG_OC_MODEL        optional -m flag (provider/model)
 *   TG_OC_VARIANT      optional --variant flag (reasoning effort)
 *   TG_OC_SEED         first-run prompt (handoff delta or startup notice)
 */

const TOPIC = process.env.TELEGRAM_TOPIC_ID ?? 'general'
const PROXY = (process.env.TELEGRAM_PROXY_URL ?? 'http://localhost:8790').replace(/\/+$/, '')
const MODEL = (process.env.TG_OC_MODEL ?? '').trim()
const VARIANT = (process.env.TG_OC_VARIANT ?? '').trim()
const SEED = process.env.TG_OC_SEED ?? ''

// Every `opencode run` child (and its telegram MCP) inherits this env. The
// flag puts server.ts into outbound-only mode: the DRIVER owns the /poll
// loop, and an MCP-side poll would consume messages this harness can never
// deliver (the claude channel notification is meaningless to opencode).
process.env.TELEGRAM_OUTBOUND_ONLY = '1'

// Per-run config injection (OPENCODE_CONFIG_CONTENT is merged last by
// opencode), so the telegram MCP and the topic permission denies exist ONLY
// for this driver's runs - they must never live in a global/project config,
// where a casually-started inbound-polling MCP would steal a topic's queue.
// The telegram MCP needs TOPIC identity: it inherits TELEGRAM_TOPIC_ID /
// TELEGRAM_PROXY_URL from this driver's env (spike-verified).
const PLUGIN_ROOT = new URL('..', import.meta.url).pathname
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  mcp: {
    telegram: {
      type: 'local',
      command: [process.execPath, PLUGIN_ROOT + 'server.ts'],
      enabled: true,
    },
  },
  permission: {
    question: 'deny', // a detached pane cannot answer an interactive prompt
    bash: {
      // The reply path is the MCP, never raw Bot API calls: block the
      // improvisation where the agent greps a token out of ~/keys and curls
      // api.telegram.org itself (observed once under a synthetic prompt).
      '*api.telegram.org*': 'deny',
      'sudo *': 'deny',
      'shutdown*': 'deny',
      'launchctl *': 'deny',
    },
  },
})

const POLL_TIMEOUT_MS = 30_000
const MINT_TRIES = 3

let sessionId = (process.env.TG_OC_SESSION_ID ?? '').trim()

function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} opencode-driver [${TOPIC}]: ${m}\n`)
}

async function proxyFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS), ...init })
}

// ---- channel block -----------------------------------------------------------
// Render the message EXACTLY in the shape a claude topic receives, so the
// shared CLAUDE.md channel discipline and the MCP instructions apply verbatim.

function escAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ')
}

function renderChannel(content: string, meta: Record<string, string>): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join('')
  return `<channel source="plugin:telegram:telegram"${attrs}>\n${content}\n</channel>`
}

// ---- opencode runs -----------------------------------------------------------

type RunResult = { ok: boolean; text: string }

/**
 * One `opencode run --format json --auto` invocation. Collects the text parts
 * (the agent's final message) and, on a minting run, the sessionID that every
 * event carries. The child inherits this driver's env, so the telegram MCP
 * sees TELEGRAM_TOPIC_ID / TELEGRAM_PROXY_URL (spike-verified).
 */
async function runOpencode(prompt: string): Promise<RunResult> {
  const args = ['run', '--format', 'json', '--auto']
  if (sessionId) args.push('-s', sessionId)
  if (MODEL) args.push('-m', MODEL)
  if (VARIANT) args.push('--variant', VARIANT)
  args.push(prompt)

  const proc = Bun.spawn(['opencode', ...args], { stdout: 'pipe', stdin: 'ignore' })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited

  let text = ''
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (!sessionId && typeof ev.sessionID === 'string') sessionId = ev.sessionID
      if (ev.type === 'text' && ev.part?.type === 'text' && typeof ev.part.text === 'string') {
        text += (text ? '\n' : '') + ev.part.text
      }
    } catch {}
  }
  return { ok: code === 0, text }
}

async function mint(): Promise<boolean> {
  const first = SEED || '(session initialized; wait for the first real user message)'
  for (let attempt = 1; attempt <= MINT_TRIES; attempt++) {
    log(`minting opencode session${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    const r = await runOpencode(first)
    if (r.ok && sessionId) {
      try {
        await proxyFetch('/oc-session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topic: TOPIC, session_id: sessionId }),
        })
        log(`minted opencode session ${sessionId}`)
        return true
      } catch (e) {
        // The session exists; the registry write is best-effort here. The
        // driver still serves it; a later respawn mints a fresh one if the
        // proxy never learned the id (accepted, documented edge).
        log(`could not POST /oc-session (${e}); continuing with ${sessionId}`)
        return true
      }
    }
    log(`mint run failed (exit ${r.ok ? 0 : 'nonzero'})`)
    await new Promise(r => setTimeout(r, 2000 * attempt))
  }
  return false
}

// ---- reply backstop -----------------------------------------------------------

async function lastReplyMarker(): Promise<string> {
  try {
    const res = await proxyFetch(`/last-reply?topic=${encodeURIComponent(TOPIC)}`)
    if (!res.ok) return 'unknown'
    const d = (await res.json()) as { last_reply_at?: number | null }
    return String(d.last_reply_at ?? '')
  } catch {
    return 'unknown'
  }
}

// ---- main loop ----------------------------------------------------------------

async function main(): Promise<void> {
  if (!sessionId && !(await mint())) {
    log('could not mint an opencode session; exiting (the proxy will respawn)')
    process.exit(1)
  }
  log(`serving topic "${TOPIC}" via proxy ${PROXY} (session ${sessionId})`)

  let backoff = 500
  while (true) {
    let msg: { content: string; meta: Record<string, string> } | null = null
    try {
      const res = await proxyFetch(`/poll?topic=${encodeURIComponent(TOPIC)}`)
      if (res.status === 204) {
        backoff = 500
        continue
      }
      if (!res.ok) throw new Error(`poll HTTP ${res.status}`)
      msg = (await res.json()) as any
      backoff = 500
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        backoff = 500 // held too long / no data - re-poll immediately
        continue
      }
      log(`poll error: ${err}, retrying in ${backoff}ms`)
      await new Promise(r => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 15_000)
      continue
    }
    if (!msg) continue

    // One run per message, strictly sequential (matches the claude topic's
    // one-turn-at-a-time behavior; the proxy queue holds the rest).
    const marker = await lastReplyMarker()
    // Channel discipline, restated per message: CLAUDE.md carries it too, but
    // it is one rule in a large file, and a missed reply is invisible to the
    // user (the claude side backstops with a Stop hook; the backstop below is
    // the only net here, so make the nudge explicit).
    const prompt =
      renderChannel(msg.content, msg.meta ?? {}) +
      '\n\n(Inbound Telegram message above. Answer the user through the telegram reply tool with ' +
      'the chat_id from the channel block - text you print here never reaches them.)'
    log(`run for message ${msg.meta?.message_id ?? '?'} (${prompt.length} chars)`)
    const r = await runOpencode(prompt)
    const after = await lastReplyMarker()
    if (!r.ok) {
      log(`run failed; telling the topic`)
      const chatId = msg.meta?.chat_id
      if (chatId) {
        await proxyFetch('/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            topic: TOPIC,
            chat_id: chatId,
            text: 'the agent hit an error running that message and it may be unanswered - resend it or say "continue".',
          }),
        }).catch(() => {})
      }
      continue
    }
    // Backstop: the run produced text, the MCP reply tools never fired (the
    // marker did not move), so the answer is stranded in this pane. Ship it.
    if (r.text && after === marker && msg.meta?.chat_id) {
      log('no reply tool call observed; shipping the run text via /send')
      await proxyFetch('/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: TOPIC, chat_id: msg.meta.chat_id, text: r.text }),
      }).catch(e => log(`backstop /send failed: ${e}`))
    }
  }
}

function shutdown(): void {
  log('shutting down')
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

await main()
