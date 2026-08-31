import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('provider proxy launcher', () => {
  const script = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'start-provider-proxy.sh'), 'utf8')

  test('prefers the activated home-manager bridge and preserves an explicit override', () => {
    expect(script).toContain('TELEGRAM_PROVIDER_PROXY_BIN')
    expect(script).toContain('.local/state/nix/profiles/home-manager/home-path/bin/claude-code-proxy')
    expect(script).toContain('exec "$proxy_bin" serve')
  })
})
