// Claude Code's per-process session records (~/.claude/sessions/<pid>.json)
// and the version the claude launcher currently resolves to.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export type LiveClaudeSession = {
  pid: number
  version?: string
  activity?: string
  activitySince?: number
  startedAt: number
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Live sessions keyed by conversation id. A record outlives its process, so
// only records whose pid is still running count.
export function liveClaudeSessions(
  dir = join(homedir(), '.claude', 'sessions'),
  isAlive: (pid: number) => boolean = alive,
): Map<string, LiveClaudeSession> {
  const sessions = new Map<string, LiveClaudeSession>()
  let names: string[]
  try {
    names = readdirSync(dir).filter(name => /^\d+\.json$/.test(name))
  } catch {
    return sessions
  }
  for (const name of names) {
    let record: any
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const pid = Number(record?.pid)
    const id = record?.sessionId
    if (!Number.isInteger(pid) || typeof id !== 'string' || !isAlive(pid)) continue
    const session: LiveClaudeSession = {
      pid,
      version: typeof record.version === 'string' ? record.version : undefined,
      activity: typeof record.status === 'string' ? record.status : undefined,
      activitySince: Number.isFinite(record.statusUpdatedAt) ? record.statusUpdatedAt : undefined,
      startedAt: Number(record.startedAt) || 0,
    }
    const existing = sessions.get(id)
    if (!existing || session.startedAt > existing.startedAt) sessions.set(id, session)
  }
  return sessions
}

// The native installer points the launcher at versions/<version>.
export function installedClaudeVersion(bin = join(homedir(), '.local', 'bin', 'claude')): string | undefined {
  try {
    const version = basename(realpathSync(bin))
    return /^\d+\.\d+\.\d+/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}
