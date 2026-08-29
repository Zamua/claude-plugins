/**
 * telegram-channel: the opencode-side counterpart of the telegram MCP's
 * inbound loop.
 *
 * Loaded only in topic panes (TELEGRAM_CHANNEL=1 plus a topic id), so normal
 * opencode sessions never poll. It runs inside the TUI's opencode instance:
 * the TUI remains the persistent, herdr-recognized session while this plugin
 * submits Telegram messages to that same session.
 *
 *   SESSION   the launcher opens the registered session with --session; a
 *             fresh topic adopts the TUI instance's newest session.
 *   READY     initialization waits for the session status to become idle.
 *   SEED      a handoff delta or startup notice is appended with noReply and
 *             acknowledged through /oc-seed-done.
 *   INBOUND   /poll messages become the same <channel> blocks Claude receives,
 *             submitted with promptAsync one at a time.
 *   OUTBOUND  the injected telegram MCP supplies reply/react/edit/download;
 *             it is outbound-only because this plugin owns /poll.
 *   BACKSTOP  session.idle ends an injected turn. tool.execute.before records
 *             a telegram_reply call; if none fired and the marker did not
 *             move, the latest assistant text is sent through /send.
 */

import { isIdleEvent, renderChannel, textFromParts } from './channel-core'

const TOPIC = process.env.TELEGRAM_TOPIC_ID ?? ''
const PROXY = (process.env.TELEGRAM_PROXY_URL ?? 'http://localhost:8790').replace(/\/+$/, '')
const BOOT_SESSION = (process.env.TG_OC_SESSION_ID ?? '').trim()
const SEED = process.env.TG_OC_SEED ?? ''

const POLL_TIMEOUT_MS = 30_000
const SESSION_READY_TRIES = 60
const SESSION_READY_DELAY_MS = 500

function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} telegram-channel [${TOPIC}]: ${m}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
    if (attempt < tries) await sleep(2000 * attempt)
  }
  return false
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

async function latestAssistantText(client: any, sessionId: string, parentId: string): Promise<string> {
  const result = await client.session.messages({
    path: { id: sessionId },
    query: { limit: 20 },
  })
  const assistant = (result?.data ?? []).find(
    (m: any) => m?.info?.role === 'assistant' && m.info.parentID === parentId,
  )
  return textFromParts(assistant?.parts ?? [])
}

export default async ({ client }: { client: any }) => {
  if (process.env.TELEGRAM_CHANNEL !== '1' || !TOPIC) return {}

  let sessionId = BOOT_SESSION
  let activeTurn: {
    messageId: string
    marker: string
    chatId: string
    replyFired: boolean
    started: boolean
  } | null = null
  let turnDone: (() => void) | null = null

  async function resolveSession(): Promise<boolean> {
    if (!sessionId) {
      for (let attempt = 1; attempt <= 30 && !sessionId; attempt++) {
        try {
          const result = await client.session.list()
          const sessions: any[] = result?.data ?? []
          const latest = sessions
            .filter(s => s?.id)
            .sort((a, b) => (b?.time?.created ?? 0) - (a?.time?.created ?? 0))[0]
          if (latest) sessionId = latest.id
        } catch (e) {
          log(`session list failed (attempt ${attempt}): ${e}`)
        }
        if (!sessionId) await sleep(1000)
      }
    }
    if (!sessionId) {
      log('no session appeared; Telegram delivery disabled for this instance')
      return false
    }

    await postWithRetry('/oc-session', { topic: TOPIC, session_id: sessionId }, 3)
    for (let attempt = 1; attempt <= SESSION_READY_TRIES; attempt++) {
      try {
        await client.session.get({ path: { id: sessionId } })
        const result = await client.session.status()
        // opencode lists busy/retrying sessions here but omits idle ones.
        const status = result?.data?.[sessionId]
        if (!status || status.type === 'idle') return true
      } catch (e) {
        if (attempt === SESSION_READY_TRIES) log(`session readiness failed: ${e}`)
      }
      await sleep(SESSION_READY_DELAY_MS)
    }
    log(`session ${sessionId} never became idle; Telegram delivery disabled`)
    return false
  }

  async function deliverSeed(): Promise<void> {
    if (!SEED) return
    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: { noReply: true, parts: [{ type: 'text', text: SEED }] },
      })
      log('seed delivered')
    } catch (e) {
      log(`seed delivery failed: ${e}`)
    }
    await postWithRetry('/oc-seed-done', { topic: TOPIC }, 3)
  }

  async function runTurn(prompt: string, chatId: string): Promise<void> {
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`
    activeTurn = {
      messageId,
      marker: await lastReplyMarker(),
      chatId,
      replyFired: false,
      started: false,
    }
    const completed = new Promise<void>(resolve => {
      turnDone = resolve
    })
    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: { messageID: messageId, parts: [{ type: 'text', text: prompt }] },
      })
    } catch (e) {
      activeTurn = null
      const resolve = turnDone
      turnDone = null
      resolve?.()
      throw e
    }
    await completed
  }

  async function backstop(turn: NonNullable<typeof activeTurn>): Promise<void> {
    // A tool attempt can fail, so the outbound marker is authoritative.
    if (turn.marker === 'unknown') return
    await sleep(1500)
    const after = await lastReplyMarker()
    if (after !== turn.marker) return
    const text = await latestAssistantText(client, sessionId, turn.messageId)
    if (!text) return
    log(`${turn.replyFired ? 'reply tool did not move the marker' : 'no reply tool call observed'}; shipping via /send`)
    await postWithRetry('/send', { topic: TOPIC, chat_id: turn.chatId, text }, 2)
  }

  async function pollLoop(): Promise<void> {
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
          backoff = 500
          continue
        }
        log(`poll error: ${err}, retrying in ${backoff}ms`)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 15_000)
        continue
      }
      if (!msg) continue
      const chatId = msg.meta?.chat_id
      if (!chatId) {
        log('dropping inbound message without chat_id')
        continue
      }
      const prompt =
        renderChannel(msg.content, msg.meta ?? {}) +
        '\n\n(Inbound Telegram message above. Answer the user through the telegram reply tool with ' +
        'the chat_id from the channel block - text you print here never reaches them.)'
      log(`turn for message ${msg.meta?.message_id ?? '?'} (${prompt.length} chars)`)
      try {
        await runTurn(prompt, chatId)
      } catch (e) {
        log(`turn failed: ${e}`)
        await postWithRetry('/send', {
          topic: TOPIC,
          chat_id: chatId,
          text: 'the agent hit an error running that message and it may be unanswered - resend it or say "continue".',
        }, 2)
      }
    }
  }

  const hooks = {
    async event({ event }: { event: any }) {
      if (
        activeTurn &&
        event?.type === 'message.updated' &&
        event.properties?.info?.id === activeTurn.messageId
      ) {
        activeTurn.started = true
        return
      }
      if (!activeTurn || !isIdleEvent(event, sessionId) || !activeTurn.started) return
      const turn = activeTurn
      activeTurn = null
      try {
        await backstop(turn)
      } catch (e) {
        log(`backstop failed: ${e}`)
      } finally {
        const resolve = turnDone
        turnDone = null
        resolve?.()
      }
    },

    async 'tool.execute.before'({ tool, sessionID }: { tool: string; sessionID: string }) {
      if (activeTurn && sessionID === sessionId && tool === 'telegram_reply') {
        activeTurn.replyFired = true
      }
    },
  }

  // Return hooks before any network or session work. Initialization can then
  // safely submit a seed and receive the idle event that completes a turn.
  void (async () => {
    if (!(await resolveSession())) return
    await deliverSeed()
    log(`serving topic "${TOPIC}" via proxy ${PROXY} (session ${sessionId})`)
    await pollLoop()
  })().catch(e => log(`plugin stopped: ${e}`))

  return hooks
}
