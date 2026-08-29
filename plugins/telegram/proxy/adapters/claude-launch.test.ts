import { describe, expect, test } from 'bun:test'
import { claudeSpawnEnv } from './claude-launch'
import type { ClaudeSpawnSpec } from './claude-launch'

const spec = (over: Partial<ClaudeSpawnSpec> = {}): ClaudeSpawnSpec => ({
  topic: '34',
  label: 'hostthis',
  sessionName: 'claude-hostthis-34',
  muxKind: 'herdr',
  spawnDir: '/Users/zamua/Dropbox/workspace/macmini',
  proxyUrl: 'http://localhost:8790',
  squareTopic: '123',
  marketplace: 'plugin:telegram@zamua',
  route: { provider: 'anthropic', model: 'fable', effort: 'xhigh' },
  claudeSessionId: 'abc-123',
  resume: false,
  settingsPath: '/settings.json',
  stopHook: '/hooks/stop-reply-guard.py',
  failoverHook: '/hooks/rate-limit-failover.py',
  capacityHook: '/hooks/provider-capacity-status.py',
  providerProxyUrl: 'http://127.0.0.1:18765',
  ...over,
})

describe('Claude launch adapter', () => {
  test('native Anthropic route keeps provider overrides empty', () => {
    const env = claudeSpawnEnv(spec())
    expect(env.TG_PROVIDER).toBe('anthropic')
    expect(env.TG_INBOUND_MODE).toBe('channel')
    expect(env.TG_PROVIDER_BASE_URL).toBe('')
    expect(env.TG_PROVIDER_AUTH_TOKEN).toBe('')
    expect(env.TG_AUTO_COMPACT_WINDOW).toBe('')
    expect(env.TG_MODEL).toBe('fable')
    expect(env.TG_EFFORT).toBe('xhigh')
    expect(env.TG_CLAUDE_SESSION_ID).toBe('abc-123')
    expect(env.TG_CAPACITY_HOOK).toBe('/hooks/provider-capacity-status.py')
    expect(env.TG_RESUME).toBe('')
  })

  test('Codex changes only the launch profile and preserves the Claude UUID', () => {
    const env = claudeSpawnEnv(spec({
      resume: true,
      route: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    }))
    expect(env.TG_PROVIDER).toBe('codex')
    expect(env.TG_INBOUND_MODE).toBe('pane')
    expect(env.TG_PROVIDER_BASE_URL).toBe('http://127.0.0.1:18765')
    expect(env.TG_PROVIDER_AUTH_TOKEN).toBe('unused')
    expect(env.TG_AUTO_COMPACT_WINDOW).toBe('272000')
    expect(env.TG_MODEL).toBe('gpt-5.6-sol[1m]')
    expect(env.TG_EFFORT).toBe('high')
    expect(env.TG_CLAUDE_SESSION_ID).toBe('abc-123')
    expect(env.TG_RESUME).toBe('1')
  })

  test('OpenCode Go is a provider route, never another harness', () => {
    const env = claudeSpawnEnv(spec({
      route: { provider: 'opencode-go', model: 'opencode-go/glm-5.2', effort: 'medium' },
    }))
    expect(env.TG_PROVIDER).toBe('opencode-go')
    expect(env.TG_INBOUND_MODE).toBe('pane')
    expect(env.TG_AUTO_COMPACT_WINDOW).toBe('100000')
    expect(env.TG_MODEL).toBe('opencode-go/glm-5.2')
    expect(Object.keys(env).some(key => key.startsWith('TG_OC_'))).toBeFalse()
    expect(env).not.toHaveProperty('TG_BACKEND')
  })
})
