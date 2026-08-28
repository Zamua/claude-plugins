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
 *             (no -s; the seed or startup notice initializes it), the session
 *             id is POSTed to the proxy (/oc-session) for the registry, and
 *             every later run (and every respawn of this driver) continues it
 *             with -s <id>. A registry id that stopped resolving (session
 *             deleted) recovers: after repeated failures the driver drops the
 *             id and re-mints.
 *   SEED      a pending handoff delta (TG_OC_SEED) is the first prompt of the
 *             FIRST run after the spawn, minting or resumed alike, and is
 *             acked via POST /oc-seed-done so the proxy stops re-delivering.
 *   OUTBOUND  nothing here - the telegram MCP (server.ts, outbound-only mode)
 *             provides reply/react/edit/download to the opencode agent; it is
 *             injected per run via OPENCODE_CONFIG_CONTENT and inherits the
 *             env this driver exports (spike-verified).
 *   BACKSTOP  the claude-only Stop hook has no opencode equivalent, so the
 *             driver fills that role: if a run produced text but the topic's
 *             last-reply marker did not move, the driver POSTs the run's final
 *             text to /send itself. A reply that made it out through the MCP
 *             moves the marker; a stranded one is rescued here.
 *
 * Env (set by launch-topic.sh via the backend's spawnEnv):
 *   TELEGRAM_TOPIC_ID / TELEGRAM_PROXY_URL   as for server.ts
 *   TG_OC_BIN          absolute opencode binary (pane PATH is unreliable)
 *   TG_OC_SESSION_ID   '' = mint on first run; else resume this id
 *   TG_OC_MODEL        optional -m flag (provider/model)
 *   TG_OC_VARIANT      optional --variant flag (reasoning effort)
 *   TG_OC_SEED         pending handoff delta (or startup notice), consumed
 *                      by the first run and acked to the proxy
 */

const TOPIC = process.env.TELEGRAM_TOPIC_ID ?? 'general'
const PROXY = (process.env.TELEGRAM_PROXY_URL ?? 'http://localhost:8790').replace(/\/+$/, '')
const OC_BIN = (process.env.TG_OC_BIN ?? '').trim() || 'opencode'
const MODEL = (process.env.TG_OC_MODEL ?? '').trim()
const VARIANT = (process.env.TG_OC_VARIANT ?? '').trim()
const SEED = process.env.TG_OC_SEED ?? ''

const POLL_TIMEOUT_MS = 30_000
const MINT_TRIES = 3
const STALE_ID_FAILURES = 3 // consecutive run failures before re-minting

let sessionId = (process.env.TG_OC_SESSION_ID ?? '').trim()
let consecutiveFailures = 0
// The in-flight opencode child, killed on shutdown: an orphaned child would
// keep burning provider tokens (and competing with the respawned driver's
// own runs) long after this pane is gone.
let currentChild: ReturnType<typeof Bun.spawn> | null = null

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

type RunResult = { ok: boolean; text: string; usedTool: boolean }

/**
 * One `opencode run --format json --auto` invocation. Collects the text parts
 * (the agent's final message), whether any tool ran (the backstop must not
 * fire when the reply tool DID fire), and, on a minting run, the sessionID
 * that every event carries. The child inherits this driver's env, so the
 * injected telegram MCP sees TELEGRAM_TOPIC_ID / TELEGRAM_PROXY_URL.
 */
async function runOpencode(prompt: string, minting: boolean): Promise<RunResult> {
  const args = ['run', '--format', 'json', '--auto']
  if (sessionId && !minting) args.push('-s', sessionId)
  if (MODEL) args.push('-m', MODEL)
  if (VARIANT) args.push('--variant', VARIANT)
  args.push(prompt)

  const proc = Bun.spawn([OC_BIN, ...args], { stdout: 'pipe', stdin: 'ignore' })
  currentChild = proc
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  currentChild = null

  let text = ''
  let usedTool = false
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (minting && !sessionId && typeof ev.sessionID === 'string') sessionId = ev.sessionID
      if (ev.type === 'tool_use' || ev.part?.type === 'tool') usedTool = true
      if (ev.type === 'text' && ev.part?.type === 'text' && typeof ev.part.text === 'string') {
        text += (text ? '\n' : '') + ev.part.text
      }
    } catch {}
  }
  return { ok: code === 0, text, usedTool }
}

async function postWithRetry(path: string, body: unknown, tries: number): Promise<boolean> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await proxyFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) return true
      log(`${path} HTTP ${res.status} (attempt ${attempt}/${tries})`)
    } catch (e) {
      log(`${path} failed (attempt ${attempt}/${tries}): ${e}`)
    }
    if (attempt < tries) await new Promise(r => setTimeout(r, 2000 * attempt))
  }
  return false
}

async function registerSession(): Promise<void> {
  // Retried: a proxy restart in this window would otherwise orphan the fresh
  // session id and the next respawn would mint a second one.
  if (await postWithRetry('/oc-session', { topic: TOPIC, session_id: sessionId }, 3)) {
    log(`minted opencode session ${sessionId}`)
  } else {
    log(`could not POST /oc-session; continuing with ${sessionId} (a later respawn will re-mint)`)
  }
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
  // The seed is the first run's prompt whatever the session state: a minting
  // run initializes the session with it, a resumed run delivers it to the
  // existing one. Either way, ack it so the proxy stops re-delivering.
  if (SEED) {
    if (sessionId) {
      const r = await runOpencode(SEED, false)
      log(`seed delivered to resumed session (ok=${r.ok})`)
    } else {
      for (let attempt = 1; attempt <= MINT_TRIES; attempt++) {
        const r = await runOpencode(SEED, true)
        if (r.ok && sessionId) {
          await registerSession()
          break
        }
        log(`mint run failed (attempt ${attempt}/${MINT_TRIES})`)
        if (attempt < MINT_TRIES) await new Promise(r2 => setTimeout(r2, 2000 * attempt))
      }
    }
    await postWithRetry('/oc-seed-done', { topic: TOPIC }, 3)
  } else if (!sessionId) {
    // Fresh topic, no handoff: initialize with a startup notice.
    for (let attempt = 1; attempt <= MINT_TRIES; attempt++) {
      const r = await runOpencode('(session initialized; wait for the first real user message)', true)
      if (r.ok && sessionId) {
        await registerSession()
        break
      }
      log(`mint run failed (attempt ${attempt}/${MINT_TRIES})`)
      if (attempt < MINT_TRIES) await new Promise(r2 => setTimeout(r2, 2000 * attempt))
    }
  }
  if (!sessionId) {
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
    const r = await runOpencode(prompt, false)
    if (!r.ok) {
      consecutiveFailures++
      log(`run failed (${consecutiveFailures} consecutive)`)
      // A registry id that no longer resolves never recovers by itself: clear
      // it at the proxy (empty session_id) and exit so the respawn mints
      // fresh instead of passing the same stale id again.
      if (consecutiveFailures >= STALE_ID_FAILURES) {
        log(`dropping session ${sessionId} after repeated failures; clearing + re-minting`)
        await postWithRetry('/oc-session', { topic: TOPIC, session_id: '' }, 2)
        sessionId = ''
        break
      }
      const chatId = msg.meta?.chat_id
      if (chatId) {
        await postWithRetry('/send', {
          topic: TOPIC,
          chat_id: chatId,
          text: 'the agent hit an error running that message and it may be unanswered - resend it or say "continue".',
        }, 2).catch(() => {})
      }
      continue
    }
    consecutiveFailures = 0
    // Backstop: the run produced text, the MCP reply tools never fired (the
    // marker did not move), so the answer is stranded in this pane. Re-check
    // after a short grace (an MCP reply can still be in flight when the run
    // exits) and never fire on unknown markers (a proxy blip must not cause
    // a duplicate).
    if (r.text && !r.usedTool && marker !== 'unknown' && msg.meta?.chat_id) {
      await new Promise(res => setTimeout(res, 2000))
      const after = await lastReplyMarker()
      if (after === marker) {
        log('no reply tool call observed; shipping the run text via /send')
        await postWithRetry('/send', {
          topic: TOPIC,
          chat_id: msg.meta.chat_id,
          text: r.text,
        }, 2).catch(e => log(`backstop /send failed: ${e}`))
      }
    }
  }
}

function shutdown(): void {
  log('shutting down')
  try {
    currentChild?.kill()
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

await main()
