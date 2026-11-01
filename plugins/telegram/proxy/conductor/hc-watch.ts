// One `events.subscribe` connection to the topics' hc core, straight to its
// socket: unlike any hc CLI call, a socket connection never starts a core.
// Requests (screen reads) go on their own short connections, since a
// subscribed connection carries only notifications.
import type { Socket } from 'bun'
import { applyHcEvent, hcSnapshot } from '../shared/hc-events'
import type { HcTerminalFacts } from '../shared/hc-events'
import { parseHcTerminals } from '../shared/hc-terminals'
import type { HcTerminal } from '../shared/hc-terminals'

export type HcWatch = {
  /** Whether the subscription is live, so what it reports is current. */
  connected(): boolean
  /** The live terminal hosting `session`, when there is one. */
  terminal(session: string): Extract<HcTerminal, { state: 'live' }> | undefined
  /** A terminal's screen as text; undefined when the core does not answer. */
  read(address: string): Promise<string | undefined>
  /** Called after each change the subscription sees, and when it drops or comes back. */
  onChange(listener: () => void): void
  stop(): void
}

const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000
/** The core sends a heartbeat every 15 s; three missed means the connection is dead. */
const SILENCE_MS = 45_000
const READ_TIMEOUT_MS = 3_000

/** Sends one JSON-RPC request on its own connection and gives the result, or undefined. */
export async function hcRequest(socket: string, method: string, params: Record<string, unknown>, timeoutMs = READ_TIMEOUT_MS): Promise<unknown> {
  return new Promise(resolve => {
    let buffer = ''
    let done = false
    let conn: Socket | undefined
    const finish = (value: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      conn?.end()
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    Bun.connect({
      unix: socket,
      socket: {
        open: s => void s.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`),
        data(_s, chunk) {
          buffer += chunk.toString()
          for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            try {
              const reply = JSON.parse(line) as { id?: unknown; result?: unknown }
              if (reply.id === 1) return finish(reply.result)
            } catch {}
          }
        },
        close: () => finish(undefined),
        error: () => finish(undefined),
        connectError: () => finish(undefined),
      },
    }).then(c => (done ? c.end() : (conn = c)), () => finish(undefined))
  })
}

export function watchHc(config: { socket: string; log: (line: string) => void; retryMinMs?: number; silenceMs?: number }): HcWatch {
  const retryMin = config.retryMinMs ?? RETRY_MIN_MS
  const silenceMs = config.silenceMs ?? SILENCE_MS
  const listeners: Array<() => void> = []
  let known = new Map<string, HcTerminalFacts>()
  let live = false
  let stopped = false
  let wasUp: boolean | undefined
  let retry = retryMin
  let conn: Socket | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let lastHeard = Date.now()
  let buffer = ''

  const changed = () => {
    for (const listener of listeners) listener()
  }

  function down(why: string) {
    conn = undefined
    if (stopped) return
    if (live || known.size) {
      live = false
      known = new Map()
      changed()
    }
    if (wasUp !== false) config.log(`conductor: hc events not connected (${why}); retrying`)
    wasUp = false
    clearTimeout(retryTimer)
    retryTimer = setTimeout(connect, retry)
    retry = Math.min(retry * 2, RETRY_MAX_MS)
  }

  function line(text: string) {
    let frame: { id?: unknown; result?: unknown; method?: unknown; params?: unknown }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.id === 1 && frame.result) {
      known = hcSnapshot(frame.result)
      live = true
      retry = retryMin
      if (wasUp !== true) config.log(`conductor: hc events connected (${known.size} terminals)`)
      wasUp = true
      changed()
    } else if (frame.method === 'event') {
      if (applyHcEvent(known, frame.params)) changed()
    } else if (frame.method === 'missed') {
      // A fresh subscription brings a fresh snapshot.
      conn?.end()
    }
  }

  function connect() {
    if (stopped) return
    buffer = ''
    lastHeard = Date.now()
    Bun.connect({
      unix: config.socket,
      socket: {
        open: s => void s.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: {} })}\n`),
        data(_s, chunk) {
          lastHeard = Date.now()
          buffer += chunk.toString()
          for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
            line(buffer.slice(0, nl))
            buffer = buffer.slice(nl + 1)
          }
        },
        close: () => down('closed'),
        error: (_s, error) => down(error.message),
        connectError: (_s, error) => down(error.message),
      },
    }).then(
      c => (stopped ? c.end() : (conn = c)),
      error => down(error instanceof Error ? error.message : String(error)),
    )
  }

  const silence = setInterval(() => {
    if (conn && Date.now() - lastHeard > silenceMs) conn.end()
  }, Math.min(silenceMs, 5_000))

  connect()

  return {
    connected: () => live,
    terminal(session) {
      if (!live) return undefined
      return parseHcTerminals({ terminals: [...known.values()] }).find(
        (t): t is Extract<HcTerminal, { state: 'live' }> => t.state === 'live' && t.session === session,
      )
    },
    async read(address) {
      const result = (await hcRequest(config.socket, 'terminal.read', { terminal: address })) as { text?: unknown } | undefined
      return typeof result?.text === 'string' ? result.text : undefined
    },
    onChange: listener => void listeners.push(listener),
    stop() {
      stopped = true
      clearTimeout(retryTimer)
      clearInterval(silence)
      conn?.end()
    },
  }
}
