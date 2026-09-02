import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'

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
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
  return true
}
