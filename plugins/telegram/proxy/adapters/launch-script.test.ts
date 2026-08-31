import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Claude provider launch script', () => {
  const script = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'launch-topic.sh'), 'utf8')

  test('pins main, subagent, auxiliary, and effort policy when resuming through another provider', () => {
    expect(script).toContain('ANTHROPIC_MODEL="$TG_MODEL"')
    expect(script).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL="$TG_AUX_MODEL"')
    expect(script).toContain('ANTHROPIC_SMALL_FAST_MODEL="$TG_AUX_MODEL"')
    expect(script).toContain('CLAUDE_CODE_SUBAGENT_MODEL="$TG_MODEL"')
    expect(script).toContain('CLAUDE_CODE_EFFORT_LEVEL="$TG_EFFORT"')
    expect(script).toContain('--disallowedTools="$TG_DISALLOWED_TOOLS"')
  })

  test('removes every proxy override on the native Anthropic route', () => {
    expect(script).toContain('unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL')
    expect(script).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  })

  test('forwards provider-aware inbound mode to both multiplexer adapters', () => {
    expect(script).toContain('-e TG_INBOUND_MODE="$TG_INBOUND_MODE"')
    expect(script).toContain('-e TG_AUX_MODEL="$TG_AUX_MODEL"')
    expect(script).toContain('-e TG_DISALLOWED_TOOLS="$TG_DISALLOWED_TOOLS"')
    expect(script).toContain("printf 'export TG_INBOUND_MODE=%q\\n' \"$TG_INBOUND_MODE\"")
    expect(script).toContain("printf 'export TG_AUX_MODEL=%q\\n' \"$TG_AUX_MODEL\"")
    expect(script).toContain("printf 'export TG_DISALLOWED_TOOLS=%q\\n' \"$TG_DISALLOWED_TOOLS\"")
  })
})
