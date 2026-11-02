// herdr-core (`hc`) as a multiplexer: each topic's Claude runs in an hc terminal
// labelled with its session name. Every call is one JSON-RPC request through
// `hc connect`, so a list returns every terminal's labels, reported status and
// foreground program at once.
import { spawnSync } from 'child_process'
import { join } from 'path'
import { hcRuntime, parseHcTerminals } from '../shared/hc-terminals'
import type { HcTerminal } from '../shared/hc-terminals'
import type { AgentRuntime } from '../shared/herdr-panes'
import { claudePromptVisible } from './multiplexer'
import type { MultiplexerPort } from './multiplexer'

/** One hc API request; null when hc refused it or could not be reached. */
export type HcCall = (method: string, params: Record<string, unknown>) => unknown | null

// The core keeps the environment it was started in and every terminal inherits
// it, so hc runs with only what places its session: never the proxy's own
// variables, the bot token among them.
const HC_ENV = ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR', 'HC_SOCKET', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']

export function hcEnvironment(env: NodeJS.ProcessEnv, session: string): Record<string, string> {
  const kept = HC_ENV.flatMap(k => (env[k] !== undefined ? [[k, env[k] as string]] : []))
  return { ...Object.fromEntries(kept), HC_SESSION: session }
}

/** Where the session's core listens, as the hc CLI finds it. */
export function hcSocketPath(env: Record<string, string | undefined>): string {
  const session = env.HC_SESSION || 'default'
  const state = env.XDG_STATE_HOME || join(env.HOME ?? '', '.local', 'state')
  return env.HC_SOCKET || join(state, 'herdr-core', session, `${session}.sock`)
}

// Connects and leaves at once: the core never has to answer or close first.
const CONNECT = 'use IO::Socket::UNIX; exit(IO::Socket::UNIX->new(Peer => $ARGV[0]) ? 0 : 1)'

/** Whether a core accepts connections on `socket`; a stale socket file does not. */
export function hcCoreListening(socket: string): boolean {
  return spawnSync('/usr/bin/perl', ['-e', CONNECT, socket], { timeout: 2_000 }).status === 0
}

/**
 * Requests through `hc connect`, which bridges stdin and stdout to the core's
 * socket. Any hc call that finds no core starts one, and that core would hold
 * the proxy's macOS privacy permissions instead of its own grant, so no call is
 * made while the session's core is down: its launchd agent starts it.
 */
export function hcConnect(
  bin: string,
  session: string,
  log: (m: string) => void,
  coreUp?: () => boolean,
): HcCall {
  const env = hcEnvironment(process.env, session)
  const up = coreUp ?? (() => hcCoreListening(hcSocketPath(env)))
  let down = false
  return (method, params) => {
    if (!up()) {
      if (!down) log(`hc core for session ${session} is not running; its launchd agent starts it, so no hc call is made`)
      down = true
      return null
    }
    if (down) log(`hc core for session ${session} is running again`)
    down = false
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const r = spawnSync(bin, ['connect'], { input: `${request}\n`, encoding: 'utf8', timeout: 10_000, env })
    if (r.status !== 0 && !r.stdout) {
      log(`hc ${method} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`)
      return null
    }
    for (const line of (r.stdout ?? '').split('\n')) {
      let reply: { id?: unknown; result?: unknown; error?: { message?: string } }
      try {
        reply = JSON.parse(line)
      } catch {
        continue
      }
      if (reply.id !== 1) continue
      if (reply.error) {
        log(`hc ${method} refused: ${reply.error.message ?? 'error'}`)
        return null
      }
      return reply.result ?? null
    }
    return null
  }
}

export class HcMux implements MultiplexerPort {
  readonly kind = 'hc' as const
  constructor(private readonly call: HcCall) {}

  // Live terminals by the session they host; finished ones hold no session.
  private terminals(): Map<string, HcTerminal> {
    const bySession = new Map<string, HcTerminal>()
    for (const t of parseHcTerminals(this.call('terminal.list', {}))) {
      if (t.session && !bySession.has(t.session)) bySession.set(t.session, t)
    }
    return bySession
  }

  private promptVisible(address: string): boolean {
    const read = this.call('terminal.read', { terminal: address }) as { text?: unknown } | null
    return typeof read?.text === 'string' && claudePromptVisible(read.text)
  }

  private runtimeOf(terminal: HcTerminal | undefined): AgentRuntime {
    const working = terminal?.state === 'live' && terminal.status === 'working'
    return hcRuntime(terminal, working && this.promptVisible(terminal.address))
  }

  liveSessions(): Set<string> {
    const live = new Set<string>()
    for (const [session, terminal] of this.terminals()) {
      if (hcRuntime(terminal) !== 'missing') live.add(session)
    }
    return live
  }

  runtime(session: string): AgentRuntime {
    return this.runtimeOf(this.terminals().get(session))
  }

  // hc's own `if: idle` refuses Claude's `done`, so the boundary is checked here.
  prompt(session: string, text: string): boolean {
    const terminal = this.terminals().get(session)
    if (!terminal || this.runtimeOf(terminal) !== 'idle') return false
    return this.call('terminal.send', { terminal: terminal.address, text }) !== null
  }

  interrupt(session: string): boolean {
    const terminal = this.terminals().get(session)
    if (!terminal || terminal.state !== 'live') return false
    return this.call('terminal.interrupt', { terminal: terminal.address }) !== null
  }

  kill(session: string): boolean {
    const terminal = this.terminals().get(session)
    if (!terminal) return false
    const killed = this.call('terminal.kill', { terminal: terminal.address }) !== null
    if (killed) this.call('terminal.rm', { terminal: terminal.address })
    return killed
  }

  /** The terminal's foreground process, when hc reports its pid. */
  agentPid(session: string): number | undefined {
    const terminal = this.terminals().get(session)
    return terminal?.state === 'live' ? terminal.foregroundPid : undefined
  }
}
