import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'launch-opencode-topic.sh')
const script = readFileSync(scriptPath, 'utf8')

// The pane script generator is the python heredoc; running it directly keeps
// the test free of Herdr.
function generatorSource(): string {
  const start = script.indexOf("<<'PY'\n") + "<<'PY'\n".length
  const end = script.indexOf('\nPY\n', start)
  return script.slice(start, end)
}

describe('OpenCode launch script', () => {
  test('parses and requires every OC_* input', () => {
    expect(spawnSync('bash', ['-n', scriptPath]).status).toBe(0)
    for (const name of [
      'OC_SESSION', 'OC_SPAWN_DIR', 'OC_BIN', 'OC_ARGS_JSON', 'OC_CONFIG_CONTENT',
      'TELEGRAM_TOPIC_ID', 'TELEGRAM_PROXY_URL',
    ]) {
      expect(script).toContain(`\${${name}:?${name} required}`)
    }
    expect(script).toContain('workspace create --cwd "$OC_SPAWN_DIR" --label "$OC_SESSION" --no-focus')
  })

  test('generated pane script exports the topic environment and execs the binary with the JSON args', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-oc-test-'))
    const fakeBinary = join(dir, 'opencode')
    writeFileSync(fakeBinary, [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$TELEGRAM_TOPIC_ID" "$TELEGRAM_PROXY_URL" "$TG_INBOUND_MODE" "$TELEGRAM_HARNESS" "$OPENCODE_CONFIG_CONTENT"',
      'printf \'[%s]\\n\' "$@"',
    ].join('\n') + '\n')
    chmodSync(fakeBinary, 0o700)
    const paneScript = join(dir, 'pane.sh')
    const args = ['/tmp/project dir', '-m', 'qwen-local/Qwen3.8-27B', '--prompt', 'kick $off; "quoted"']
    const config = JSON.stringify({ mcp: { 'telegram-topics': {
      type: 'local', command: ['/tmp/bun', '/tmp/plugin/server.ts'], enabled: true,
    } } })

    const generated = spawnSync('python3', [
      '-', paneScript, fakeBinary, JSON.stringify(args), '/usr/bin:/bin', '42',
      'http://127.0.0.1:8790', config,
    ], { input: generatorSource(), encoding: 'utf8' })
    expect(generated.status).toBe(0)

    const body = readFileSync(paneScript, 'utf8')
    expect(body).toContain('export TG_INBOUND_MODE=pane\n')
    expect(body).toContain('export TELEGRAM_HARNESS=opencode\n')
    expect(body).toContain('export OPENCODE_CONFIG_CONTENT=')
    expect(body).toMatch(/\nexec .*opencode /)

    const ran = spawnSync('bash', [paneScript], { encoding: 'utf8', env: { HOME: dir } })
    expect(ran.status).toBe(0)
    expect(ran.stdout.split('\n')).toEqual([
      '42', 'http://127.0.0.1:8790', 'pane', 'opencode', config,
      ...args.map(argument => `[${argument}]`),
      '',
    ])
  })
})
