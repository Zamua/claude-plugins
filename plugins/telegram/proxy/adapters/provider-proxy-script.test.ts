import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'start-provider-proxy.sh')

// A fake bridge that records how it was started instead of serving.
const FAKE_BRIDGE = `#!/usr/bin/env bash
{
  printf 'args=%s\\n' "$*"
  printf 'umask=%s\\n' "$(umask)"
  printf 'continuation=%s\\n' "\${CCP_CODEX_PREVIOUS_RESPONSE_ID-unset}"
  printf 'opencode_key=%s\\n' "\${CCP_OPENCODE_API_KEY-unset}"
} > "$HOME/bridge.out"
`

type Env = Record<string, string> | ((home: string) => Record<string, string>)

function start(env: Env = {}, setup: (home: string) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'tg-bridge-'))
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude-code-proxy'), FAKE_BRIDGE)
  chmodSync(join(bin, 'claude-code-proxy'), 0o700)
  setup(home)
  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      HOME: home,
      USER: 'telegram-test-user',
      PATH: '/usr/bin:/bin',
      TELEGRAM_OPENCODE_GO_KEY_FILE: join(home, 'no-key'),
      TELEGRAM_OPENCODE_BIN: join(home, 'no-opencode'),
      ...(typeof env === 'function' ? env(home) : env),
    },
  })
  const out = Object.fromEntries(
    readFileSync(join(home, 'bridge.out'), 'utf8').trim().split('\n').map(line => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1)]
    }),
  )
  return { result, home, out }
}

describe('start-provider-proxy.sh', () => {
  test('starts the bridge from PATH on the default loopback port', () => {
    const run = start()
    expect(run.result.status).toBe(0)
    expect(run.out.args).toBe('serve --no-monitor --port 18765')
  })

  test('an explicit bridge binary and port win over PATH', () => {
    const run = start(
      home => ({ TELEGRAM_PROVIDER_PROXY_BIN: join(home, 'pinned-bridge'), TELEGRAM_PROVIDER_PROXY_PORT: '19000' }),
      home => {
        writeFileSync(join(home, 'pinned-bridge'), FAKE_BRIDGE)
        chmodSync(join(home, 'pinned-bridge'), 0o700)
        writeFileSync(join(home, '.local', 'bin', 'claude-code-proxy'), '#!/bin/sh\nexit 3\n')
      },
    )
    expect(run.result.status).toBe(0)
    expect(run.out.args).toBe('serve --no-monitor --port 19000')
  })

  test('enables Codex continuation by default and keeps an operator override', () => {
    expect(start().out.continuation).toBe('1')
    expect(start({ CCP_CODEX_PREVIOUS_RESPONSE_ID: '0' }).out.continuation).toBe('0')
  })

  test('hands the OpenCode Go key file to the bridge only, trimmed', () => {
    const run = start({}, home => writeFileSync(join(home, 'no-key'), '  sk-test-key\n'))
    expect(run.out.opencode_key).toBe('sk-test-key')
    expect(start().out.opencode_key).toBe('unset')
  })

  test('keeps bridge logs private, including older ones', () => {
    const run = start({}, home => {
      mkdirSync(join(home, '.local', 'state', 'claude-code-proxy'), { recursive: true })
      writeFileSync(join(home, '.local', 'state', 'claude-code-proxy', 'proxy.log'), '', { mode: 0o644 })
      mkdirSync(join(home, '.pm2', 'logs'), { recursive: true })
      writeFileSync(join(home, '.pm2', 'logs', 'claude-code-proxy-out.log'), '', { mode: 0o644 })
    })
    expect(run.out.umask).toBe('0077')
    expect(statSync(join(run.home, '.local', 'state', 'claude-code-proxy', 'proxy.log')).mode & 0o777).toBe(0o600)
    expect(statSync(join(run.home, '.pm2', 'logs', 'claude-code-proxy-out.log')).mode & 0o777).toBe(0o600)
  })
})
