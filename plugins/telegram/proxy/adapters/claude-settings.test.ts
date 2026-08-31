import { describe, expect, test } from 'bun:test'
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
})
