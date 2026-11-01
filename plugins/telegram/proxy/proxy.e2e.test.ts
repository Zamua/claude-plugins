import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

// The proxy as a whole, booted from a copy of the plugin (so no .env of the
// checkout reaches it) against a stand-in Bot API and a stand-in tmux and
// claude, under a temporary HOME and state directory. Nothing here reaches
// Telegram, a multiplexer or a model.

const GROUP = '-1007770000001'
const OPERATOR = 4242
const RESUMED = '11111111-1111-4111-8111-111111111111'
const MISSING = '22222222-2222-4222-8222-222222222222'

const FAKE_TMUX = `#!/usr/bin/env bash
live="$HOME/fake/live"; touch "$live"
case "$1" in
  ls) cat "$live" ;;
  has-session) grep -qx "\${3#=}" "$live"; exit $? ;;
  new-session)
    shift; name=''; envs=()
    while [ $# -gt 0 ]; do
      case "$1" in
        -d) shift ;;
        -s) name="$2"; shift 2 ;;
        -c) shift 2 ;;
        -e) envs+=("$2"); shift 2 ;;
        *) shift ;;
      esac
    done
    echo "$name" >> "$live"
    { echo "session=$name"; printf '%s\\n' "\${envs[@]}"; echo; } >> "$HOME/fake/spawns" ;;
  kill-session) grep -vx "\${3#=}" "$live" > "$live.new"; mv "$live.new" "$live" ;;
esac
exit 0
`
const FAKE_CLAUDE = `#!/usr/bin/env bash
[ "$1" = --version ] && { echo "2.1.316 (Claude Code)"; exit 0; }
exit 0
`

type Call = { method: string; body: Record<string, any> }

let root: string
let home: string
let state: string
let proxy: Subprocess
let proxyUrl: string
let api: ReturnType<typeof Bun.serve>
const calls: Call[] = []
const pending: unknown[] = []
let updateId = 1
let messageId = 100

const until = async <T>(what: string, probe: () => T | undefined | false, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${proxyLog()}`)
    await Bun.sleep(100)
  }
}

function send(thread: number, text: string) {
  pending.push({
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(GROUP), type: 'supergroup', title: 'topics', is_forum: true },
      from: { id: OPERATOR, is_bot: false, first_name: 'Operator' },
      message_thread_id: thread,
      is_topic_message: true,
      text,
    },
  })
}

const spawns = () =>
  existsSync(join(home, 'fake', 'spawns'))
    ? readFileSync(join(home, 'fake', 'spawns'), 'utf8').split('\n\n').filter(Boolean).map(block => {
        const [first, ...rest] = block.trim().split('\n')
        return { session: first.replace('session=', ''), env: Object.fromEntries(rest.map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) }
      })
    : []

const proxyLog = () => (existsSync(join(root, 'proxy.log')) ? readFileSync(join(root, 'proxy.log'), 'utf8').slice(-3000) : '')

const registry = () => JSON.parse(readFileSync(join(state, 'registry.json'), 'utf8'))

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tg-proxy-e2e-'))
  home = join(root, 'home')
  state = join(root, 'state')
  const plugin = join(root, 'plugin')
  const source = dirname(import.meta.dir)
  cpSync(source, plugin, {
    recursive: true,
    filter: src => !['.env', 'node_modules'].includes(basename(src)) && !src.endsWith('.test.ts'),
  })
  cpSync(join(import.meta.dir, 'node_modules'), join(plugin, 'proxy', 'node_modules'), { recursive: true })

  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  mkdirSync(join(home, 'fake'))
  for (const [name, body] of [['tmux', FAKE_TMUX], ['claude', FAKE_CLAUDE]]) {
    writeFileSync(join(home, '.local', 'bin', name), body)
    chmodSync(join(home, '.local', 'bin', name), 0o700)
  }
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', 'p', `${RESUMED}.jsonl`), '{}\n')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'registry.json'), JSON.stringify({
    '43': { tmux_session: 'claude-resumed-43', thread_id: 43, name: 'resumed', spawned_at: 1, claude_session_id: RESUMED },
    '44': { tmux_session: 'claude-gone-44', thread_id: 44, name: 'gone', spawned_at: 1, claude_session_id: MISSING },
  }))

  api = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').at(-1) ?? ''
      const text = await req.text()
      let body: Record<string, any> = {}
      try { body = text ? JSON.parse(text) : {} } catch {}
      calls.push({ method, body })
      const ok = (result: unknown) => Response.json({ ok: true, result })
      if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'fake', username: 'fakebot' })
      if (method === 'getUpdates') {
        if (pending.length === 0) await Bun.sleep(200)
        return ok(pending.splice(0))
      }
      if (method === 'sendMessage') {
        return ok({ message_id: messageId++, date: 0, chat: { id: Number(GROUP), type: 'supergroup' }, text: body.text })
      }
      return ok(true)
    },
  })

  const free = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = free.port
  free.stop(true)
  proxyUrl = `http://127.0.0.1:${port}`
  proxy = Bun.spawn([process.execPath, join(plugin, 'proxy', 'proxy.ts')], {
    env: {
      HOME: home,
      USER: 'test',
      PATH: `${join(home, '.local', 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TELEGRAM_BOT_TOKEN: '123:fake',
      TELEGRAM_GROUP_CHAT_ID: GROUP,
      TELEGRAM_PROXY_PORT: String(port),
      TELEGRAM_BOT_API_ROOT: `http://127.0.0.1:${api.port}`,
      TELEGRAM_TOPICS_STATE_DIR: state,
      TELEGRAM_TOPICS_SPAWN_DIR: home,
      TELEGRAM_TOPICS_MULTIPLEXER: 'tmux',
      TELEGRAM_ANTIGRAVITY: 'off',
      TELEGRAM_TOPICS_UPDATE_RESTART: 'off',
      TELEGRAM_TOPICS_VOICE_TRANSCRIBE: 'off',
      // Absent binaries, so no capacity probe or catalog runs a real CLI
      TELEGRAM_OPENCODE_BIN: join(root, 'absent', 'opencode'),
      TELEGRAM_PROVIDER_PROXY_BIN: join(root, 'absent', 'claude-code-proxy'),
      TELEGRAM_ANTIGRAVITY_BIN: join(root, 'absent', 'agy'),
    },
    stdout: Bun.file(join(root, 'proxy.log')),
    stderr: Bun.file(join(root, 'proxy.log')),
  })
  await (async () => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const health = await fetch(`${proxyUrl}/health`).then(r => r.json()).catch(() => undefined)
      if (health?.polling) return
      if (Date.now() > deadline) throw new Error(`the proxy never started polling:\n${proxyLog()}`)
      await Bun.sleep(150)
    }
  })()
}, 40_000)

afterAll(() => {
  proxy?.kill()
  api?.stop(true)
})

describe('the proxy, end to end', () => {
  test('reports health with the topics it reloaded from the registry', async () => {
    const health = await fetch(`${proxyUrl}/health`).then(r => r.json())
    expect(health.ok).toBeTrue()
    expect(health.topics).toEqual(expect.arrayContaining(['43', '44']))
  }, 20_000)

  test('a first message in a new topic spawns a fresh conversation and records it', async () => {
    send(42, 'hello')
    const spawned = await until('topic 42 to spawn', () => spawns().find(s => s.session === 'claude-42'))
    expect(spawned.env.TG_RESUME).toBe('')
    expect(spawned.env.TELEGRAM_TOPIC_ID).toBe('42')
    expect(spawned.env.TG_CLAUDE_SESSION_ID).toMatch(/^[0-9a-f-]{36}$/)
    const saved = await until('the registry to record topic 42', () => registry()['42'])
    expect(saved.claude_session_id).toBe(spawned.env.TG_CLAUDE_SESSION_ID)
    expect(saved.tmux_session).toBe('claude-42')
  }, 20_000)

  test('a message in a topic whose agent is gone resumes its conversation', async () => {
    send(43, 'are you there')
    const resumed = await until('topic 43 to resume', () => spawns().find(s => s.session === 'claude-resumed-43'))
    expect(resumed.env.TG_RESUME).toBe('1')
    expect(resumed.env.TG_CLAUDE_SESSION_ID).toBe(RESUMED)
  }, 20_000)

  test('a topic bound to a missing conversation is told so and starts nothing', async () => {
    send(44, 'hello?')
    const notice = await until('the missing-conversation notice', () =>
      calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 44 && /no longer exists/.test(c.body.text)))
    expect(notice.body.chat_id).toBe(GROUP)
    expect(spawns().some(s => s.session.endsWith('-44'))).toBeFalse()
  }, 20_000)

  test('a malformed request is refused with a 400 naming the field', async () => {
    const res = await fetch(`${proxyUrl}/react`, {
      method: 'POST',
      body: JSON.stringify({ chat_id: GROUP, message_id: 'abc', emoji: '👍' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('message_id')
  })
})
