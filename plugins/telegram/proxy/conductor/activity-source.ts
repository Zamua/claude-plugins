// Keeps what each working hc topic is doing: the tool its transcript shows in
// flight, else the spinner on its screen. Refreshed on a timer; listeners hear
// only when a label changes, so a topic event follows at most once a refresh.
import { hcRuntime } from '../shared/hc-terminals'
import type { HcTerminal } from '../shared/hc-terminals'
import { spinnerActivity, transcriptActivity } from './domain/activity'
import type { Activity } from './domain/activity'

export type ActivitySourcePorts = {
  /** The topics whose sessions run on hc. */
  topics: () => Iterable<string>
  terminal: (topic: string) => HcTerminal | undefined
  sessionId: (topic: string) => string | undefined
  /** The last lines of a conversation's transcript, the first possibly cut. */
  transcriptTail: (sessionId: string) => string[] | undefined
  screen: (address: string) => Promise<string | undefined>
  now?: () => number
}

export function activitySource(ports: ActivitySourcePorts) {
  const now = ports.now ?? Date.now
  const current = new Map<string, Activity>()
  const listeners: Array<() => void> = []
  let refreshing = false

  async function look(topic: string): Promise<Activity | undefined> {
    const terminal = ports.terminal(topic)
    const runtime = hcRuntime(terminal)
    if (runtime !== 'busy' && runtime !== 'blocked') return undefined
    const id = ports.sessionId(topic)
    const lines = id ? ports.transcriptTail(id) : undefined
    const tool = lines ? transcriptActivity(lines, now()) : undefined
    if (tool || terminal?.state !== 'live') return tool
    const screen = await ports.screen(terminal.address).catch(() => undefined)
    return screen ? spinnerActivity(screen, now()) : undefined
  }

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      let changed = false
      const seen = new Set<string>()
      for (const topic of ports.topics()) {
        seen.add(topic)
        const before = current.get(topic)
        const next = await look(topic)
        if (!next) {
          if (before) changed = current.delete(topic)
          continue
        }
        // A spinner's start is derived from its elapsed time, which drifts; the first one seen holds.
        current.set(topic, before?.label === next.label ? { ...next, since: before.since } : next)
        if (before?.label !== next.label) changed = true
      }
      for (const topic of current.keys()) {
        if (!seen.has(topic)) changed = current.delete(topic)
      }
      if (changed) for (const listener of listeners) listener()
    } finally {
      refreshing = false
    }
  }

  return {
    refresh,
    activity: (topic: string): Activity | undefined => current.get(topic),
    onChange: (listener: () => void) => void listeners.push(listener),
  }
}

export type ActivitySource = ReturnType<typeof activitySource>
