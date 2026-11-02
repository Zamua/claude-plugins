import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const SESSION_ID = /^[A-Za-z0-9-]+$/

export function defaultClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

// Claude Code stores each conversation as projects/<sanitized cwd>/<id>.jsonl.
// The cwd a topic was spawned from can change over time, so any project
// directory counts.
export function claudeConversationExists(sessionId: string, configDir = defaultClaudeConfigDir()): boolean {
  if (!SESSION_ID.test(sessionId)) return false
  const projects = join(configDir, 'projects')
  let entries: string[]
  try {
    entries = readdirSync(projects)
  } catch {
    return false
  }
  return entries.some(entry => existsSync(join(projects, entry, `${sessionId}.jsonl`)))
}

/** Where a conversation's transcript is, in any project directory. */
export function claudeTranscriptPath(sessionId: string, configDir = defaultClaudeConfigDir()): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined
  const projects = join(configDir, 'projects')
  try {
    for (const entry of readdirSync(projects)) {
      const path = join(projects, entry, `${sessionId}.jsonl`)
      if (existsSync(path)) return path
    }
  } catch {}
  return undefined
}

/**
 * Reads the last `bytes` of a conversation's transcript as lines, the first
 * possibly cut. A transcript unchanged since the last read is not read again.
 */
export function transcriptTails(configDir = defaultClaudeConfigDir(), bytes = 128 * 1024) {
  const paths = new Map<string, string>()
  const last = new Map<string, { size: number; mtimeMs: number; lines: string[] }>()
  return (sessionId: string): string[] | undefined => {
    const path = paths.get(sessionId) ?? claudeTranscriptPath(sessionId, configDir)
    if (!path) return undefined
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      const { size, mtimeMs } = fstatSync(fd)
      paths.set(sessionId, path)
      const seen = last.get(sessionId)
      if (seen && seen.size === size && seen.mtimeMs === mtimeMs) return seen.lines
      const length = Math.min(size, bytes)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n').filter(Boolean)
      last.set(sessionId, { size, mtimeMs, lines })
      return lines
    } catch {
      paths.delete(sessionId)
      last.delete(sessionId)
      return undefined
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}
