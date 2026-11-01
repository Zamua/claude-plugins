import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { syncAntigravityTelegramMcp } from './antigravity-mcp-config'

describe('Antigravity Telegram MCP config adapter', () => {
  test('adds the outbound adapter while preserving existing MCP servers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-mcp-'))
    const file = join(dir, 'mcp_config.json')
    try {
      writeFileSync(file, JSON.stringify({ mcpServers: { existing: { command: 'existing' } } }))
      const changed = syncAntigravityTelegramMcp(file, '/bin/bun', '/repo/server.ts')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      expect(changed).toBeTrue()
      expect(config.mcpServers.existing.command).toBe('existing')
      expect(config.mcpServers['telegram-topics']).toEqual({
        command: '/bin/bun', args: ['/repo/server.ts'],
      })
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(syncAntigravityTelegramMcp(file, '/bin/bun', '/repo/server.ts')).toBeFalse()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses to overwrite malformed user configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-mcp-'))
    const file = join(dir, 'mcp_config.json')
    try {
      writeFileSync(file, '{not-json')
      expect(() => syncAntigravityTelegramMcp(file, '/bin/bun', '/repo/server.ts')).toThrow()
      expect(readFileSync(file, 'utf8')).toBe('{not-json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
