import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { claudeSpawnEnv } from '../topics/claude-launch'
import type { ClaudeSpawnSpec } from '../topics/claude-launch'

const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'launch-topic.sh')

// A socket that accepts connections, standing in for the hc session's running core.
const coreSocket = join(mkdtempSync(join(tmpdir(), 'tg-core-')), 'core.sock')
const core = Bun.listen({ unix: coreSocket, socket: { data() {} } })
afterAll(() => core.stop(true))

// Fakes on the launcher's PATH. Both multiplexers start the pane command
// synchronously and without the launcher's environment, as a server that
// predates the launcher would: tmux passes only its `-e` variables, herdr none.
// `seq` prints nothing so the dialog watchers exit at once. `claude` records
// its argv and environment.
const FAKES: Record<string, string> = {
  herdr: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/fake/calls"
case "$1 $2" in
  "pane list") cat "$HOME/fake/panes.json" ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"},"pane":{"pane_id":"p1"}}}' ;;
  "pane run") env -i HOME="$HOME" CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=1 CLAUDE_CODE_SESSION_ID=parent bash -c "$4" ;;
esac
`,
  tmux: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/fake/calls"
case "$1" in
  has-session) exit 1 ;;
  new-session)
    [ -e "$HOME/fake/no-server" ] && { echo 'no server running' >&2; exit 1; }
    shift; envs=(); cmd=''
    while [ $# -gt 0 ]; do
      case "$1" in
        -d) shift ;;
        -s|-c) shift 2 ;;
        -e) envs+=("$2"); shift 2 ;;
        *) cmd="$1"; shift ;;
      esac
    done
    env -i HOME="$HOME" CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=1 CLAUDE_CODE_SESSION_ID=parent "\${envs[@]}" bash -c "$cmd" ;;
esac
`,
  hc: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/fake/calls"
env > "$HOME/fake/hc.env"
case "$1" in
  ls) cat "$HOME/fake/terminals.json" ;;
  run)
    [ -e "$HOME/fake/no-core" ] && exit 1
    shift; argv=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --name|--cwd|--label) shift 2 ;;
        --*) shift ;;
        *) argv+=("$1"); shift ;;
      esac
    done
    env -i HOME="$HOME" CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=1 CLAUDE_CODE_SESSION_ID=parent "\${argv[@]}" ;;
esac
`,
  seq: '#!/bin/sh\nexit 0\n',
  claude: `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$HOME/fake/claude.args"
env > "$HOME/fake/claude.env"
`,
}

const baseSpec = (over: Partial<ClaudeSpawnSpec> = {}): ClaudeSpawnSpec => ({
  topic: '34',
  label: 'hostthis',
  sessionName: 'claude-hostthis-34',
  muxKind: 'herdr',
  spawnDir: '/tmp/spawn dir',
  proxyUrl: 'http://localhost:8790',
  squareTopic: '123',
  marketplace: 'plugin:telegram@zamua',
  route: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'xhigh', ultracode: false },
  auxiliaryModel: 'haiku',
  claudeSessionId: 'abc-123',
  resume: false,
  settingsPath: '/tmp/settings.json',
  stopHook: '/hooks/stop-reply-guard.py',
  failoverHook: '/hooks/rate-limit-failover.py',
  capacityHook: '/hooks/provider-capacity-status.py',
  providerProxyUrl: 'http://127.0.0.1:18765',
  ...over,
})

// Variables the launcher consumes itself; every other one must reach the pane.
const LAUNCHER_ONLY = new Set(['TG_SESSION', 'TG_MUX', 'TG_SPAWN_DIR'])

function launch(spec: ClaudeSpawnSpec, panes: unknown[] = [], tmuxDown = false, terminals: unknown[] = [], hcSocket = coreSocket) {
  const home = mkdtempSync(join(tmpdir(), 'tg-launch-'))
  const bin = join(home, '.local', 'bin')
  const fake = join(home, 'fake')
  mkdirSync(bin, { recursive: true })
  mkdirSync(fake)
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o700)
  }
  writeFileSync(join(fake, 'panes.json'), JSON.stringify({ result: { panes } }))
  if (tmuxDown) {
    writeFileSync(join(fake, 'no-server'), '')
    writeFileSync(join(fake, 'no-core'), '')
  }
  writeFileSync(join(fake, 'terminals.json'), JSON.stringify({ terminals }))
  const spawnEnv = claudeSpawnEnv(spec)
  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { HOME: home, USER: 'test', PATH: '/usr/bin:/bin', TMPDIR: home, TELEGRAM_BOT_TOKEN: 'bot-token', HC_SOCKET: hcSocket, ...spawnEnv },
  })
  const read = (file: string) => (existsSync(join(fake, file)) ? readFileSync(join(fake, file), 'utf8') : '')
  const paneEnv = Object.fromEntries(read('claude.env').split('\n').filter(Boolean).map(line => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }))
  return {
    result,
    spawnEnv,
    args: read('claude.args').split('\n').slice(0, -1),
    paneEnv,
    calls: read('calls').trim().split('\n').filter(Boolean),
    hcEnv: read('hc.env'),
  }
}

describe('launch-topic.sh', () => {
  for (const mux of ['herdr', 'tmux', 'hc'] as const) {
    describe(`under ${mux}`, () => {
      test('every per-topic variable the proxy sets reaches the Claude pane unchanged', () => {
        const run = launch(baseSpec({ muxKind: mux }))
        expect(run.result.status).toBe(0)
        for (const [key, value] of Object.entries(run.spawnEnv)) {
          if (LAUNCHER_ONLY.has(key)) continue
          expect([key, run.paneEnv[key]]).toEqual([key, value])
        }
        expect(run.paneEnv.MCP_TIMEOUT).toBe('180000')
      })

      test('a server started inside another Claude does not make the topic\'s Claude its child', () => {
        const run = launch(baseSpec({ muxKind: mux }))
        expect(['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID'].filter(k => k in run.paneEnv)).toEqual([])
      })

      test('Claude gets USER, which it finds its login by, from a server environment without one', () => {
        expect(launch(baseSpec({ muxKind: mux })).paneEnv.USER).toBe(userInfo().username)
      })

      test('a first launch mints the conversation with the kickoff under checked auto mode', () => {
        const run = launch(baseSpec({ muxKind: mux }))
        expect(run.args).toEqual([
          '--dangerously-load-development-channels=plugin:telegram@zamua',
          '--settings', '/tmp/settings.json',
          '--disallowedTools=AskUserQuestion,Workflow',
          '--permission-mode', 'auto',
          '--model', 'claude-opus-5-5',
          '--effort', 'xhigh',
          '--session-id', 'abc-123', run.spawnEnv.TG_KICKOFF,
        ])
        expect(run.paneEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-opus-5-5')
        expect(run.paneEnv.CLAUDE_CODE_EFFORT_LEVEL).toBe('xhigh')
        expect(run.paneEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001')
        expect(run.paneEnv.ANTHROPIC_BASE_URL).toBeUndefined()
      })

      test('a Codex resume keeps the conversation, bypasses approvals and routes through the bridge', () => {
        const run = launch(baseSpec({
          muxKind: mux,
          resume: true,
          route: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium', ultracode: true },
          auxiliaryModel: 'gpt-5.6-luna',
          modelContextWindow: 1_000_000,
        }))
        expect(run.args).toContain('--dangerously-skip-permissions')
        expect(run.args).not.toContain('--permission-mode')
        expect(run.args).toContain('--disallowedTools=AskUserQuestion')
        expect(run.args.slice(-2)).toEqual(['--resume', 'abc-123'])
        expect(run.paneEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18765')
        expect(run.paneEnv.ANTHROPIC_MODEL).toBe('gpt-5.6-sol[1m]')
        expect(run.paneEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe('gpt-5.6-sol[1m]')
        expect(run.paneEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe('gpt-5.6-luna[1m]')
        expect(run.paneEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(run.spawnEnv.TG_AUTO_COMPACT_WINDOW)
        expect(run.paneEnv.TG_INBOUND_MODE).toBe('pane')
      })

      test('a provider-default effort passes no effort at all', () => {
        const run = launch(baseSpec({
          muxKind: mux,
          route: { provider: 'opencode-go', model: 'opencode-go/glm-5.2', effort: 'auto', ultracode: false },
        }))
        expect(run.args).not.toContain('--effort')
        expect(run.paneEnv.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
      })
    })
  }

  test('herdr labels the workspace without the claude- marker and the pane with the session name', () => {
    const run = launch(baseSpec())
    expect(run.calls).toContain('workspace create --cwd /tmp/spawn dir --label hostthis-34 --no-focus')
    expect(run.calls).toContain('pane rename p1 claude-hostthis-34')
  })

  test('a tmux session that cannot be created fails the launch, so the proxy reports it', () => {
    const run = launch(baseSpec({ muxKind: 'tmux' }), [], true)
    expect(run.result.status).toBe(1)
    expect(run.result.stderr).toContain('tmux could not create session claude-hostthis-34')
  })

  test('herdr leaves a live agent alone and replaces a restored dead pane', () => {
    const live = launch(baseSpec(), [{ label: 'claude-hostthis-34', pane_id: 'p0', agent_status: 'idle' }])
    expect(live.result.status).toBe(0)
    expect(live.calls).toEqual(['pane list'])

    const stale = launch(baseSpec(), [{ label: 'claude-hostthis-34', pane_id: 'p0', agent_status: 'unknown' }])
    expect(stale.calls.slice(0, 2)).toEqual(['pane list', 'pane close p0'])
    expect(stale.args).toContain('--session-id')
  })

  test('hc names the terminal by topic and labels it with the session, outside any parent terminal', () => {
    const run = launch(baseSpec({ muxKind: 'hc' }))
    expect(run.result.status).toBe(0)
    expect(run.calls[0]).toBe('ls --all --json --label session=claude-hostthis-34')
    expect(run.calls[1]).toMatch(
      /^run --bg --json --no-parent --no-notify --name tg-34 --label session=claude-hostthis-34 --label topic=34 --cwd \/tmp\/spawn dir bash \S+tg-topic-\w+$/,
    )
  })

  test('hc leaves a live agent alone, and clears the session\'s finished terminals before starting it again', () => {
    const live = launch(baseSpec({ muxKind: 'hc' }), [], false, [{ address: 't1', state: 'live' }])
    expect(live.result.status).toBe(0)
    expect(live.calls).toEqual(['ls --all --json --label session=claude-hostthis-34'])

    const finished = launch(baseSpec({ muxKind: 'hc' }), [], false, [{ address: 't1', state: 'finished' }, { address: 't2', state: 'finished' }])
    expect(finished.calls.slice(1, 3)).toEqual(['rm t1', 'rm t2'])
    expect(finished.args).toContain('--session-id')
  })

  test('hc never gets the proxy\'s own environment, which a core it starts would hand every terminal', () => {
    const run = launch(baseSpec({ muxKind: 'hc' }))
    expect(run.paneEnv.TELEGRAM_TOPIC_ID).toBe('34')
    expect(run.hcEnv).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(run.hcEnv).not.toContain('TG_KICKOFF')
  })

  test('hc never starts a core: with the session\'s core down the launch fails before any hc call', () => {
    const run = launch(baseSpec({ muxKind: 'hc' }), [], false, [], join(tmpdir(), `tg-no-core-${process.pid}.sock`))
    expect(run.result.status).toBe(1)
    expect(run.result.stderr).toContain('the hc core for session default is not running')
    expect(run.calls).toEqual([])
  })

  test('an hc terminal that cannot start fails the launch, so the proxy reports it', () => {
    const run = launch(baseSpec({ muxKind: 'hc' }), [], true)
    expect(run.result.status).toBe(1)
    expect(run.result.stderr).toContain('hc could not start terminal tg-34 for claude-hostthis-34')
  })
})
