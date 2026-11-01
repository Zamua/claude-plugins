import { existsSync, readdirSync } from 'fs'
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
