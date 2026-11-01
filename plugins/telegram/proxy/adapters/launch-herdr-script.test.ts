import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'launch-herdr-topic.sh')

// A fake `herdr` on PATH records every call and runs `pane run` synchronously,
// so the launcher executes end to end with no Herdr server.
const FAKE_HERDR = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE/calls"
case "$1 $2" in
  "pane list") cat "$FAKE/panes.json" ;;
  "workspace create") [ -f "$FAKE/fail-create" ] && exit 1; echo '{"result":{"pane":{"pane_id":"p-new"}}}' ;;
  "pane run") bash -c "$4" > "$FAKE/pane.out" 2>&1 ;;
esac
`

// Stands in for the agent: prints the environment it was started with, then its argv.
const FAKE_AGENT = `#!/usr/bin/env bash
printf '%s\\n' "$TELEGRAM_TOPIC_ID" "$TELEGRAM_PROXY_URL" "$TG_INBOUND_MODE" "$TELEGRAM_HARNESS" "\${OPENCODE_CONFIG_CONTENT-unset}"
printf '[%s]\\n' "$@"
`

function fixture(panes: unknown[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'tg-herdr-launch-'))
  const fake = join(home, 'fake')
  const bin = join(home, '.local', 'bin')
  mkdirSync(fake)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'herdr'), FAKE_HERDR)
  chmodSync(join(bin, 'herdr'), 0o700)
  const agent = join(home, 'agent')
  writeFileSync(agent, FAKE_AGENT)
  chmodSync(agent, 0o700)
  writeFileSync(join(fake, 'panes.json'), JSON.stringify({ result: { panes } }))
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    HOME: home,
    USER: 'test',
    PATH: '/usr/bin:/bin',
    TMPDIR: home,
    FAKE: fake,
    HX_HARNESS: 'opencode',
    HX_SESSION: 'oc-topic-42',
    HX_SPAWN_DIR: '/tmp/project dir',
    HX_BIN: agent,
    HX_ARGS_JSON: JSON.stringify(['/tmp/project dir', '--prompt', 'kick $off; "quoted"']),
    TELEGRAM_TOPIC_ID: '42',
    TELEGRAM_PROXY_URL: 'http://127.0.0.1:8790',
    ...extra,
  })
  const launch = (extra?: Record<string, string>) =>
    spawnSync('bash', [scriptPath], { env: env(extra), encoding: 'utf8' })
  const calls = () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n') : [])
  const paneOutput = () => readFileSync(join(fake, 'pane.out'), 'utf8').split('\n')
  return { fake, launch, calls, paneOutput }
}

describe('launch-herdr-topic.sh', () => {
  test('starts the agent in a new labeled workspace with the topic environment and exact argv', () => {
    const f = fixture()
    const config = JSON.stringify({ model: 'qwen-local/Qwen3.8-27B' })
    const result = f.launch({ HX_ENV_JSON: JSON.stringify({ OPENCODE_CONFIG_CONTENT: config }) })

    expect(result.status).toBe(0)
    expect(f.calls()).toContain('workspace create --cwd /tmp/project dir --label oc-topic-42 --no-focus')
    expect(f.calls()).toContain('pane rename p-new oc-topic-42')
    expect(f.paneOutput()).toEqual([
      '42', 'http://127.0.0.1:8790', 'pane', 'opencode', config,
      '[/tmp/project dir]', '[--prompt]', '[kick $off; "quoted"]',
      '',
    ])
  })

  test('exports no extra variables when HX_ENV_JSON is absent', () => {
    const f = fixture()
    expect(f.launch({ HX_HARNESS: 'antigravity' }).status).toBe(0)
    expect(f.paneOutput().slice(3, 5)).toEqual(['antigravity', 'unset'])
  })

  test('leaves a live agent alone', () => {
    const f = fixture([{ label: 'oc-topic-42', pane_id: 'p-old', agent_status: 'idle' }])
    expect(f.launch().status).toBe(0)
    expect(f.calls()).toEqual(['pane list'])
  })

  test('closes a restored pane whose agent is gone, then starts a new one', () => {
    const f = fixture([{ label: 'oc-topic-42', pane_id: 'p-old', agent_status: 'unknown' }])
    expect(f.launch().status).toBe(0)
    expect(f.calls().slice(0, 3)).toEqual([
      'pane list',
      'pane close p-old',
      'workspace create --cwd /tmp/project dir --label oc-topic-42 --no-focus',
    ])
  })

  test('fails loudly when the workspace cannot be created', () => {
    const f = fixture()
    writeFileSync(join(f.fake, 'fail-create'), '')
    const result = f.launch()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('workspace creation failed for oc-topic-42')
  })

  test('refuses an extra variable name that is not a plain identifier', () => {
    const f = fixture()
    const result = f.launch({ HX_ENV_JSON: JSON.stringify({ 'PATH; rm -rf': 'x' }) })
    expect(result.status).toBe(1)
    expect(f.calls()).not.toContainEqual(expect.stringMatching(/^pane run/))
  })

  test('refuses to start without a required input', () => {
    const f = fixture()
    const result = f.launch({ HX_SESSION: '' })
    expect(result.status).not.toBe(0)
    expect(f.calls()).toEqual([])
  })
})
