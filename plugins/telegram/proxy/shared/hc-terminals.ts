// herdr-core terminals as the proxy reads them from `terminal.list`: alive or
// finished, the session they host (their `session` label), the status the agent
// reported over OSC 7501, and the program in the foreground.
import type { AgentRuntime } from './herdr-panes'

export type HcStatus = 'idle' | 'working' | 'done' | 'blocked' | 'error'

/** A terminal that has not reported a status yet carries none; `title` is what its program last set, when any. */
export type HcTerminal =
  | {
      state: 'live'
      address: string
      session?: string
      status?: HcStatus
      foreground?: string
      title?: string
      cols?: number
      /** What a blocked program said it waits on: the kind (permission, question, auth) and its message. */
      blocked?: { kind: string | null; msg: string }
    }
  | { state: 'finished'; address: string; session?: string }

const STATUSES = new Set<string>(['idle', 'working', 'done', 'blocked', 'error'])
const SHELL = /^(zsh|bash|sh|fish|dash|ksh|nu)$/

/** The terminals in a `terminal.list` result; anything else is none, never a guess. */
export function parseHcTerminals(listed: unknown): HcTerminal[] {
  const terminals = (listed as { terminals?: unknown })?.terminals
  if (!Array.isArray(terminals)) return []
  return terminals.flatMap((t): HcTerminal[] => {
    if (typeof t?.address !== 'string') return []
    const session = typeof t.labels?.session === 'string' ? { session: t.labels.session as string } : {}
    if (t.state !== 'live') return [{ state: 'finished', address: t.address, ...session }]
    const status = t.reported && STATUSES.has(t.status?.state) ? { status: t.status.state as HcStatus } : {}
    const foreground = typeof t.foreground?.name === 'string' ? { foreground: t.foreground.name as string } : {}
    const title = typeof t.title === 'string' && t.title.trim() ? { title: t.title.trim() as string } : {}
    const cols = Number.isInteger(t.cols) ? { cols: t.cols as number } : {}
    const blocked = t.reported && t.status?.state === 'blocked'
      ? { blocked: { kind: typeof t.status.kind === 'string' ? t.status.kind : null, msg: typeof t.status.msg === 'string' ? t.status.msg : '' } }
      : {}
    return [{ state: 'live', address: t.address, ...session, ...status, ...foreground, ...title, ...cols, ...blocked }]
  })
}

/**
 * Claude reports `done` after every turn and `idle` only at boot or after a
 * resume, so both are promptable; so is `error`, a turn that ended on an API
 * error. A working agent whose foreground prompt is blank runs only background
 * work. Before its first report a terminal is starting, unless all that is left
 * in it is a shell: then the agent is gone.
 */
export function hcRuntime(terminal: HcTerminal | undefined, promptVisible = false): AgentRuntime {
  if (!terminal || terminal.state === 'finished') return 'missing'
  switch (terminal.status) {
    case 'idle':
    case 'done':
    case 'error':
      return 'idle'
    case 'working':
      return promptVisible ? 'idle' : 'busy'
    case 'blocked':
      return 'blocked'
    case undefined:
      return terminal.foreground && !SHELL.test(terminal.foreground) ? 'starting' : 'missing'
  }
}
