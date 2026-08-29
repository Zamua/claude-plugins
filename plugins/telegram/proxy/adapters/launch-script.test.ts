import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Claude provider launch script', () => {
  const script = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'launch-topic.sh'), 'utf8')

  test('pins both proxy model env variables when resuming through another provider', () => {
    expect(script).toContain('ANTHROPIC_MODEL="$TG_MODEL"')
    expect(script).toContain('ANTHROPIC_SMALL_FAST_MODEL="$TG_MODEL"')
  })

  test('removes every proxy override on the native Anthropic route', () => {
    expect(script).toContain('unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL')
    expect(script).toContain('ANTHROPIC_SMALL_FAST_MODEL CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  })

  test('forwards provider-aware inbound mode to both multiplexer adapters', () => {
    expect(script).toContain('-e TG_INBOUND_MODE="$TG_INBOUND_MODE"')
    expect(script).toContain("printf 'export TG_INBOUND_MODE=%q\\n' \"$TG_INBOUND_MODE\"")
  })
})
