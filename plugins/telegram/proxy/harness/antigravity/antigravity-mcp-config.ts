import {
  chmodSync,
  existsSync,
  readFileSync,
} from 'fs'
import { writeJsonAtomic } from '../../shared/json-file'

const SERVER_NAME = 'telegram-topics'

export function syncAntigravityTelegramMcp(
  file: string,
  bunBinary: string,
  serverFile: string,
): boolean {
  let root: Record<string, unknown> = {}
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim()
    if (text) root = JSON.parse(text) as Record<string, unknown>
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error(`invalid Antigravity MCP config in ${file}`)
  }
  const existing = root.mcpServers
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error(`invalid mcpServers map in ${file}`)
  }
  const servers = { ...(existing as Record<string, unknown> | undefined) }
  const desired = { command: bunBinary, args: [serverFile] }
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(desired)) {
    chmodSync(file, 0o600)
    return false
  }
  servers[SERVER_NAME] = desired
  const next = { ...root, mcpServers: servers }
  writeJsonAtomic(file, next)
  return true
}
