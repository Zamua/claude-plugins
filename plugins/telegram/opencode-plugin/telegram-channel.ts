/**
 * telegram-channel: the opencode-side counterpart of the telegram MCP's
 * inbound loop.
 *
 * Loaded ONLY in topic panes (env-gated: TELEGRAM_CHANNEL=1 +
 * TELEGRAM_TOPIC_ID, both set by the launcher for opencode backends), so
 * casual opencode sessions never poll. Runs inside the TUI's own opencode
 * server process and delivers inbound Telegram messages by submitting them
 * INTO the session the attached TUI is displaying, so the pane and the
 * Telegram thread stay the same conversation:
 *
 *   SESSION   the launcher opens the TUI with `--session <registry id>` when
 *             one exists; a fresh topic boots a new session and the plugin
 *             adopts it (latest session of this instance) and registers it
 *             via POST /oc-session for the proxy's registry.
 *   SEED      a pending handoff delta or startup notice (TG_OC_SEED) is the
 *             FIRST prompt of the session, then acked via POST /oc-seed-done.
 *   INBOUND   long-poll GET {PROXY}/poll?topic={TOPIC} (same contract as
 *             server.ts), render the SAME <channel> block a claude topic
 *             gets, and `client.session.prompt` it. Prompts serialize per
 *             session, matching the one-turn-at-a-time claude behavior.
 *   OUTBOUND  the injected telegram MCP (outbound-only) provides reply/react/
 *             edit/download to the agent; env it inherits carries topic
 *             identity (spike-verified).
 *   BACKSTOP  opencode has no Stop hook: around each injected turn, compare
 *             GET /last-reply markers; if the turn produced text but no tool
 *             ran and the marker did not move, POST the text to /send.
 */

const TOPIC = process.env.TELEGRAM_TOPIC_ID ?? ''
const PROXY = (process.env.TELEGRAM_PROXY_URL ?? 'http://localhost:8790').replace(/\/+$/, '')
const BOOT_SESSION = (process.env.TG_OC_SESSION_ID ?? '').trim()
const SEED = process.env.TG_OC_SEED ?? ''

const POLL_TIMEOUT_MS = 30_000
// Boot grace, the same lesson as server.ts's FIRST_POLL_DELAY_MS: a prompt
// injected while the TUI is still loading the session (a big transcript takes
// seconds) is silently never processed - measured: injected at ~300ms post-boot
// it vanishes, at ~8s it runs. Only the first poll waits; warm ones are fine.
const BOOT_DELAY_MS = Number(process.env.TELEGRAM_TOPICS_FIRST_POLL_DELAY_MS ?? 6000)

function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} telegram-channel [${TOPIC}]: ${m}\n`)
}

async function proxyFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS), ...init })
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

// ---- channel block -----------------------------------------------------------
// The SAME shape a claude topic receives, so the shared CLAUDE.md discipline
// and the MCP instructions apply verbatim.

function escAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ')
}

function renderChannel(content: string, meta: Record<string, string>): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join('')
  return `<channel source="plugin:telegram:telegram"${attrs}>\n${content}\n</channel>`
}

export default async ({ client }: { client: any }) => {
  // Gate: topic panes only (the launcher exports both for opencode backends).
  if (process.env.TELEGRAM_CHANNEL !== '1' || !TOPIC) return {}

  // Resolve the session this TUI displays. A resumed spawn boots with
  // --session <registry id>; a fresh topic's TUI creates one at boot, so wait
  // for the instance's first session to appear.
  let sessionId = BOOT_SESSION
  if (!sessionId) {
    for (let attempt = 1; attempt <= 15 && !sessionId; attempt++) {
      try {
        const res = await client.session.list()
        const sessions: Array<any> = res.data ?? []
        const latest = sessions
          .filter((s: any) => s?.id)
          .sort((a: any, b: any) => (b?.time?.created ?? 0) - (a?.time?.created ?? 0))[0]
        if (latest) sessionId = latest.id
      } catch (e) {
        log(`session list failed (attempt ${attempt}): ${e}`)
      }
      if (!sessionId) await new Promise(r => setTimeout(r, 1000))
    }
    if (!sessionId) {
      log('no session appeared; telegram delivery disabled for this instance')
      return {}
    }
  }
  log(`serving topic "${TOPIC}" via proxy ${PROXY} (session ${sessionId})`)
  await postWithRetry('/oc-session', { topic: TOPIC, session_id: sessionId }, 3)

  // Let the TUI finish loading the session before the first prompt (see
  // BOOT_DELAY_MS; the seed counts as the first prompt).
  if (BOOT_DELAY_MS > 0) await new Promise(r => setTimeout(r, BOOT_DELAY_MS))

  // The seed (handoff delta or startup notice) is the session's first prompt;
  // ack it so the proxy stops re-delivering on later respawns.
  if (SEED) {
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: SEED }] },
      })
      log('seed delivered')
    } catch (e) {
      log(`seed run failed: ${e}`)
    }
    await postWithRetry('/oc-seed-done', { topic: TOPIC }, 3)
  }

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

  // Inbound loop: one injected turn at a time (client.session.prompt awaits
  // the assistant reply, so the queue drains serially).
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

    const marker = await lastReplyMarker()
    // Channel discipline, restated per message (the claude side backstops
    // with a Stop hook; this is the only net here).
    const prompt =
      renderChannel(msg.content, msg.meta ?? {}) +
      '\n\n(Inbound Telegram message above. Answer the user through the telegram reply tool with ' +
      'the chat_id from the channel block - text you print here never reaches them.)'
    log(`turn for message ${msg.meta?.message_id ?? '?'} (${prompt.length} chars)`)
    let text = ''
    let usedTool = false
    try {
      const out = await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: prompt }] },
      })
      const parts: Array<any> = out?.data?.parts ?? []
      for (const p of parts) {
        if (p?.type === 'tool') usedTool = true
        if (p?.type === 'text' && typeof p.text === 'string') text += (text ? '\n' : '') + p.text
      }
    } catch (e) {
      log(`turn failed: ${e}`)
      const chatId = msg.meta?.chat_id
      if (chatId) {
        await postWithRetry('/send', {
          topic: TOPIC,
          chat_id: chatId,
          text: 'the agent hit an error running that message and it may be unanswered - resend it or say "continue".',
        }, 2)
      }
      continue
    }
    // Backstop: text produced, no reply tool fired, marker unmoved (re-checked
    // after a short grace for an MCP reply still in flight; unknown markers
    // never fire - a proxy blip must not cause a duplicate).
    if (text && !usedTool && marker !== 'unknown' && msg.meta?.chat_id) {
      await new Promise(r => setTimeout(r, 2000))
      const after = await lastReplyMarker()
      if (after === marker) {
        log('no reply tool call observed; shipping the turn text via /send')
        await postWithRetry('/send', {
          topic: TOPIC,
          chat_id: msg.meta.chat_id,
          text,
        }, 2)
      }
    }
  }
}
