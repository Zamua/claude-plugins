// Moving live topic Claudes onto a newly installed Claude Code without ever
// cutting a turn short.

export type UpdateRestartInput = {
  // Version the live session started with.
  running?: string
  // Version the claude launcher resolves to now.
  installed?: string
  // Claude Code's own status for the session: busy (mid-turn), shell (idle
  // but background tasks still running), waiting (on the user), or idle.
  activity?: string
  // The proxy still holds work for the topic: a queued message, an in-flight
  // pane turn, or an unanswered permission prompt.
  proxyBusy: boolean
  // The topic was busy at an earlier check for this update.
  deferred: boolean
  // The topic was already restarted for this installed version.
  attempted: boolean
}

// stop: end the session; it resumes on its next message.
// restart: end it and resume it straight away.
export type UpdateRestartAction = 'none' | 'wait' | 'stop' | 'restart'

const numericParts = (version: string): number[] | undefined => {
  const match = /^(\d+(?:\.\d+)*)/.exec(version.trim())
  return match ? match[1].split('.').map(Number) : undefined
}

// Negative when a is older than b. Unparseable versions compare equal, so
// they never trigger a restart.
export function compareVersions(a: string, b: string): number {
  const left = numericParts(a)
  const right = numericParts(b)
  if (!left || !right) return 0
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function updateRestartAction(input: UpdateRestartInput): UpdateRestartAction {
  if (!input.running || !input.installed || input.attempted) return 'none'
  if (compareVersions(input.running, input.installed) >= 0) return 'none'
  if (input.activity !== 'idle' || input.proxyBusy) return 'wait'
  return input.deferred ? 'restart' : 'stop'
}
