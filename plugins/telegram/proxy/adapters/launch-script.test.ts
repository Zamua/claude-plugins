import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { join } from 'path'

describe('Claude provider launch script', () => {
  const script = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'launch-topic.sh'), 'utf8')

  test('bypasses approvals only for Codex on fresh launches and resumes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-launch-'))
    try {
      const capture = join(dir, 'capture-args')
      writeFileSync(capture, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
      chmodSync(capture, 0o700)
      const pane = script.match(/PANE_CMD='([\s\S]*?)'\n/)![1]
      for (const provider of ['codex', 'anthropic', 'opencode-go', '']) {
        for (const resume of ['', '1']) {
          const result = spawnSync('/bin/bash', ['-c', pane], {
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              TG_PATH: process.env.PATH,
              TG_PROVIDER: provider,
              TG_CLAUDE_BIN: capture,
              TG_CLAUDE_SESSION_ID: 'test-conversation',
              TG_MODEL: provider === 'codex' ? 'gpt-6.1-sol' : 'test-model',
              TG_RESUME: resume,
              TG_KICKOFF: 'test kickoff',
            },
          })
          expect(result.status).toBe(0)
          const args = result.stdout.trim().split('\n')
          expect(args.includes('--dangerously-skip-permissions')).toBe(provider === 'codex')
          expect(args.includes('--permission-mode')).toBe(provider !== 'codex')
          if (provider !== 'codex') expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto')
          expect(args).toContain(resume ? '--resume' : '--session-id')
          expect(args).toContain('test-conversation')
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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
    expect(script).toContain('-e TG_AUTHORIZATION_HOOK="$TG_AUTHORIZATION_HOOK"')
    expect(script).toContain("printf 'export TG_INBOUND_MODE=%q\\n' \"$TG_INBOUND_MODE\"")
    expect(script).toContain("printf 'export TG_AUX_MODEL=%q\\n' \"$TG_AUX_MODEL\"")
    expect(script).toContain("printf 'export TG_DISALLOWED_TOOLS=%q\\n' \"$TG_DISALLOWED_TOOLS\"")
    expect(script).toContain("printf 'export TG_AUTHORIZATION_HOOK=%q\\n' \"$TG_AUTHORIZATION_HOOK\"")
  })
})
