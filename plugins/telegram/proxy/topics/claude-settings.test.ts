import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { effectiveClaudeSettings } from './claude-settings'

describe('Claude settings adapter', () => {
  test('applies Ultracode per route without mutating shared base settings', () => {
    const base = { permissions: { allow: ['Bash(git status)'] }, ultracode: true }
    const off = effectiveClaudeSettings(base, {
      provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium', ultracode: false,
    })
    const on = effectiveClaudeSettings(base, {
      provider: 'anthropic', model: 'fable', effort: 'xhigh', ultracode: true,
    })

    expect(off.ultracode).toBeFalse()
    expect(on.ultracode).toBeTrue()
    expect(base.ultracode).toBeTrue()
    expect(off).not.toBe(on)
  })

  test('keeps built-in soft rules while making exfiltration human-overridable', () => {
    const base = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'override-settings.json'), 'utf8'))
    expect(base.autoMode.soft_deny[0]).toBe('$defaults')
    expect(base.autoMode.soft_deny[1]).toContain('exact data, destination, and transfer')
    expect(base.autoMode.hard_deny).toHaveLength(1)
    expect(base.autoMode.hard_deny[0]).toStartWith('No unconditional classifier blocks')
    expect(base.autoMode.hard_deny[0]).not.toContain('$defaults')
  })
})
