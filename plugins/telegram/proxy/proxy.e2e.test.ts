import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { ANTIGRAVITY_DISABLED_MESSAGE } from './harness/antigravity/disabled-antigravity-runtime'

// The proxy as a whole, booted from a copy of the plugin (so no .env of the
// checkout reaches it) against a stand-in Bot API and a stand-in tmux and
// claude, under a temporary HOME and state directory. Nothing here reaches
// Telegram, a multiplexer or a model.

const GROUP = '-1007770000001'
const OPERATOR = 4242
const RESUMED = '11111111-1111-4111-8111-111111111111'
const MISSING = '22222222-2222-4222-8222-222222222222'
const PROXIED = '33333333-3333-4333-8333-333333333333'

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
    { echo "session=$name"; printf '%s\\n' "\${envs[@]}"; echo; } >> "$HOME/fake/spawns"
    # A fresh conversation writes its transcript, as Claude does on its first turn
    id=''; resume=''
    for e in "\${envs[@]}"; do
      case "$e" in TG_CLAUDE_SESSION_ID=*) id="\${e#*=}" ;; TG_RESUME=*) resume="\${e#*=}" ;; esac
    done
    [ -n "$id" ] && [ -z "$resume" ] && echo '{}' > "$HOME/.claude/projects/p/$id.jsonl" ;;
  kill-session) grep -vx "\${3#=}" "$live" > "$live.new"; mv "$live.new" "$live" ;;
  # Every pane shows Claude's empty prompt, so a proxied topic reads as idle
  capture-pane) printf '\n❯ \n' ;;
  load-buffer) cat >> "$HOME/fake/pasted" ;;
esac
exit 0
`
const FAKE_CLAUDE = `#!/usr/bin/env bash
[ "$1" = --version ] && { echo "2.1.316 (Claude Code)"; exit 0; }
exit 0
`

// Herdr and OpenCode stand-ins for a localcode topic: panes live in a JSON
// file, `pane run` runs the pane script at once, and the opencode "TUI"
// records its argv on its pane and, unless resuming, creates one session.
const FAKE_HERDR = `#!/usr/bin/env python3
import json, os, subprocess, sys
def dumps(v): return json.dumps(v, separators=(',', ':'))
home = os.environ['HOME']; fake = os.path.join(home, 'fake'); st = os.path.join(fake, 'herdr.json')
state = json.load(open(st)) if os.path.exists(st) else {'panes': [], 'n': 0}
a = sys.argv[1:]
open(os.path.join(fake, 'herdr.calls'), 'a').write(' '.join(a) + '\\n')
def save(): json.dump(state, open(st, 'w'))
cmd = ' '.join(a[:2])
if cmd == 'pane list':
    print(dumps({'result': {'panes': [{'label': p['label'], 'pane_id': p['id'], 'agent_status': 'idle'} for p in state['panes']]}}))
elif cmd == 'workspace create':
    state['n'] += 1; pid = 'p%d' % state['n']
    state['panes'].append({'id': pid, 'label': a[a.index('--label') + 1], 'argv': []}); save()
    print(dumps({'result': {'workspace': {'workspace_id': 'w%d' % state['n']}, 'pane': {'pane_id': pid}}}))
elif cmd == 'pane rename':
    for p in state['panes']:
        if p['id'] == a[2]: p['label'] = a[3]
    save()
elif cmd == 'pane run':
    subprocess.run(['bash', '-c', a[3]], env={'HOME': home, 'FAKE_PANE': a[2], 'PATH': '/usr/bin:/bin'})
elif cmd == 'pane process-info':
    pid = a[a.index('--pane') + 1]
    argv = next((p['argv'] for p in json.load(open(st))['panes'] if p['id'] == pid), [])
    print(dumps({'result': {'process_info': {'foreground_processes': [{'name': 'opencode', 'argv': argv}]}}}))
elif cmd == 'pane close':
    state['panes'] = [p for p in state['panes'] if p['id'] != a[2]]; save()
`
const FAKE_OPENCODE = `#!/usr/bin/env python3
import json, os, sys, time
fake = os.path.join(os.environ['HOME'], 'fake'); sessions = os.path.join(fake, 'oc-sessions.json')
a = sys.argv[1:]
if a[:2] == ['session', 'list']:
    print(open(sessions).read() if os.path.exists(sessions) else '[]'); sys.exit(0)
if a[:2] == ['session', 'export']:
    print(json.dumps({'messages': []})); sys.exit(0)
if not os.environ.get('FAKE_PANE'): sys.exit(1)
st = os.path.join(fake, 'herdr.json'); state = json.load(open(st))
for p in state['panes']:
    if p['id'] == os.environ.get('FAKE_PANE'): p['argv'] = ['opencode'] + a
json.dump(state, open(st, 'w'))
if '-s' not in a:
    now = int(time.time() * 1000)
    json.dump([{'id': 'ses_fake1', 'created': now, 'updated': now}], open(sessions, 'w'))
`
// A 1x1 PNG, as the qwen-image server would return one.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type Call = { method: string; body: Record<string, any> }

let root: string
let home: string
let state: string
let proxy: Subprocess
let proxyUrl: string
let api: ReturnType<typeof Bun.serve>
let qwenImage: ReturnType<typeof Bun.serve>
const generations: Record<string, any>[] = []
const calls: Call[] = []
const pending: unknown[] = []
let updateId = 1
let messageId = 100

const until = async <T>(what: string, probe: () => T | undefined | false, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) {
      const sent = calls.filter(c => c.method === 'sendMessage').slice(-6).map(c => `${c.body.message_thread_id}: ${c.body.text}`)
      throw new Error(`timed out waiting for ${what}\nlast messages:\n${sent.join('\n')}\n${proxyLog()}`)
    }
    await Bun.sleep(100)
  }
}

function send(thread: number, text: string): number {
  const id = messageId
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
  return id
}

// A service message, such as a topic being created or renamed, in `thread`.
function deliver(thread: number, fields: Record<string, unknown>) {
  pending.push({
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(GROUP), type: 'supergroup', title: 'topics', is_forum: true },
      from: { id: OPERATOR, is_bot: false, first_name: 'Operator' },
      message_thread_id: thread,
      is_topic_message: true,
      ...fields,
    },
  })
}

// The operator pressing an inline button under a message in `thread`.
function press(thread: number, data: string) {
  pending.push({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: OPERATOR, is_bot: false, first_name: 'Operator' },
      chat_instance: '1',
      data,
      message: {
        message_id: 999,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(GROUP), type: 'supergroup', title: 'topics', is_forum: true },
        message_thread_id: thread,
        is_topic_message: true,
        text: 'picker',
      },
    },
  })
}

type Button = { text: string; callback_data: string }
const buttons = (call: Call | undefined): Button[] => (call?.body.reply_markup?.inline_keyboard ?? []).flat()

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
  for (const [name, body] of [['tmux', FAKE_TMUX], ['herdr', FAKE_HERDR], ['opencode', FAKE_OPENCODE]]) {
    writeFileSync(join(home, '.local', 'bin', name), body)
    chmodSync(join(home, '.local', 'bin', name), 0o700)
  }
  // Laid out as the native installer does: the launcher links to versions/<version>
  const installed = join(home, '.local', 'share', 'claude', 'versions', '2.1.316')
  mkdirSync(dirname(installed), { recursive: true })
  writeFileSync(installed, FAKE_CLAUDE)
  chmodSync(installed, 0o700)
  symlinkSync(installed, join(home, '.local', 'bin', 'claude'))
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', 'p', `${RESUMED}.jsonl`), '{}\n')
  writeFileSync(join(home, '.claude', 'projects', 'p', `${PROXIED}.jsonl`), '{}\n')
  mkdirSync(state, { recursive: true })
  // A harness topic file that cannot be read must not keep the proxy from booting
  writeFileSync(join(state, 'localgen-topics.json'), '{"version":1,"topics":[')
  writeFileSync(join(state, 'registry.json'), JSON.stringify({
    '43': { tmux_session: 'claude-resumed-43', thread_id: 43, name: 'resumed', spawned_at: 1, claude_session_id: RESUMED },
    '44': { tmux_session: 'claude-gone-44', thread_id: 44, name: 'gone', spawned_at: 1, claude_session_id: MISSING },
    '46': {
      tmux_session: 'claude-proxied-46', thread_id: 46, name: 'proxied', spawned_at: 1, claude_session_id: PROXIED,
      route: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium', ultracode: false },
    },
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
      if (method === 'createForumTopic') return ok({ message_thread_id: 77, name: body.name, icon_color: 0 })
      if (method === 'sendPhoto' || method === 'sendDocument') {
        return ok({ message_id: messageId++, date: 0, chat: { id: Number(GROUP), type: 'supergroup' } })
      }
      if (method === 'sendMessage') {
        return ok({ message_id: messageId++, date: 0, chat: { id: Number(GROUP), type: 'supergroup' }, text: body.text })
      }
      return ok(true)
    },
  })

  qwenImage = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/v1/images/generations') return new Response('no', { status: 404 })
      generations.push(await req.json())
      return Response.json({ data: [{ b64_json: PNG }] })
    },
  })
  mkdirSync(join(root, 'oc-project'))

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
      TELEGRAM_TOPICS_UPDATE_SWEEP_MS: '300',
      TELEGRAM_TOPICS_VOICE_TRANSCRIBE: 'off',
      TELEGRAM_TOPICS_SQUARE_TOPIC_ID: '900',
      TELEGRAM_TOPICS_SECRETS_USER_ID: String(OPERATOR),
      TELEGRAM_TOPICS_SECRETS_DIR: join(root, 'keys'),
      // Stand-ins or absent binaries, so nothing here runs a real CLI or reaches a real Herdr
      TELEGRAM_HERDR_BIN: join(home, '.local', 'bin', 'herdr'),
      TELEGRAM_OPENCODE_BIN: join(home, '.local', 'bin', 'opencode'),
      TELEGRAM_OPENCODE_PROJECT_DIR: join(root, 'oc-project'),
      LOCALGEN_PORT: String(qwenImage.port),
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
  qwenImage?.stop(true)
})

describe('the proxy, end to end', () => {
  test('reports health with the topics it reloaded from the registry', async () => {
    const health = await fetch(`${proxyUrl}/health`).then(r => r.json())
    expect(health.ok).toBeTrue()
    expect(health.topics).toEqual(expect.arrayContaining(['43', '44']))
  }, 20_000)

  test('boots past an unreadable harness topic file, keeping its bytes beside it', () => {
    const aside = readdirSync(state).find(f => f.startsWith('localgen-topics.json.unreadable-'))
    expect(aside).toBeDefined()
    expect(readFileSync(join(state, aside!), 'utf8')).toBe('{"version":1,"topics":[')
  })

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

  test('a topic on a proxied route gets its turns typed into its idle pane, never through /poll', async () => {
    send(46, 'over the bridge')
    const spawned = await until('topic 46 to resume', () => spawns().find(s => s.session === 'claude-proxied-46'))
    expect(spawned.env.TG_CLAUDE_SESSION_ID).toBe(PROXIED)
    const pasted = await until('the turn to be pasted', () => {
      const file = join(home, 'fake', 'pasted')
      return existsSync(file) && readFileSync(file, 'utf8').includes('over the bridge') && readFileSync(file, 'utf8')
    })
    expect(pasted).toContain('<channel source="plugin:telegram:telegram"')
    expect(pasted).toContain('message_thread_id="46"')
    expect((await fetch(`${proxyUrl}/poll?topic=46`)).status).toBe(204)
  }, 20_000)

  test('a message sent after an agent died mid-poll reaches the next poll, not the dead one', async () => {
    send(49, 'hi')
    await until('topic 49 to spawn', () => spawns().find(s => s.session === 'claude-49'))
    expect((await fetch(`${proxyUrl}/poll?topic=49`).then(r => r.json())).content).toContain('hi')
    // The agent's MCP dies while its long-poll is held
    const dying = new AbortController()
    const held = fetch(`${proxyUrl}/poll?topic=49`, { signal: dying.signal }).catch(() => undefined)
    await Bun.sleep(300)
    dying.abort()
    await held
    await Bun.sleep(200)
    send(49, 'after the crash')
    const next = await fetch(`${proxyUrl}/poll?topic=49`, { signal: AbortSignal.timeout(5_000) }).then(r => r.json())
    expect(next.content).toContain('after the crash')
  }, 20_000)

  test('a square tag posts the root and a breadcrumb, and the peer can poll it and reply', async () => {
    const tag = await fetch(`${proxyUrl}/square/tag`, {
      method: 'POST',
      body: JSON.stringify({ topic: '42', peer: '43', text: 'can you check the build?' }),
    })
    expect(tag.status).toBe(200)
    const root = calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 900)
    expect(root?.body.text).toBe('🤖 42 → @resumed\ncan you check the build?')
    expect(calls.some(c => c.method === 'sendMessage' && c.body.message_thread_id === 42 && /asked @resumed in #square/.test(c.body.text)))
      .toBeTrue()

    // Topic 43 still holds the turn the resume test sent; the square delivery queues behind it
    let polled = await fetch(`${proxyUrl}/poll?topic=43`).then(r => r.json())
    if (polled.meta.square !== '1') polled = await fetch(`${proxyUrl}/poll?topic=43`).then(r => r.json())
    expect(polled.meta.square).toBe('1')
    expect(polled.content).toContain('can you check the build?')

    const reply = await fetch(`${proxyUrl}/square/reply`, {
      method: 'POST',
      body: JSON.stringify({ topic: '43', conv: polled.meta.conv, reply_token: polled.meta.reply_token, text: 'green' }),
    })
    expect(reply.status).toBe(200)
    const answer = calls.findLast(c => c.method === 'sendMessage' && c.body.message_thread_id === 900)
    expect(answer?.body.text).toBe(`🤖 resumed · #${polled.meta.conv}\ngreen`)
    expect(answer?.body.reply_parameters).toEqual({ message_id: Number(polled.meta.reply_token) })
  }, 20_000)

  test('a /secret is stored owner-only, deleted from the chat, acked, and its topic told without the value', async () => {
    const id = send(42, '/secret apikey\nsk-test-123')
    const file = join(root, 'keys', 'apikey')
    await until('the secret file', () => existsSync(file))
    expect(readFileSync(file, 'utf8')).toBe('sk-test-123\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    await until('the message deleted', () => calls.find(c => c.method === 'deleteMessage' && c.body.message_id === id))
    await until('the ack', () => calls.find(c => c.method === 'sendMessage' && /🔐 stored .*apikey \(11 bytes\)/.test(c.body.text)))
    let notice: any
    for (let i = 0; i < 4 && notice?.meta?.secret_drop !== '1'; i++) {
      notice = await fetch(`${proxyUrl}/poll?topic=42`).then(r => r.json())
    }
    expect(notice.meta.secret_drop).toBe('1')
    expect(notice.content).not.toContain('sk-test-123')
  }, 20_000)

  test('a bare /secret asks for the name, then the value, and stores it', async () => {
    send(42, '/secret')
    await until('the name prompt', () => calls.find(c => c.method === 'sendMessage' && c.body.reply_markup?.force_reply))
    const prompts = () => calls.filter(c => c.method === 'sendMessage' && c.body.reply_markup?.force_reply).length
    send(42, 'guided')
    await until('the value prompt', () => prompts() >= 2)
    send(42, 'v2')
    const file = join(root, 'keys', 'guided')
    await until('the guided secret file', () => existsSync(file))
    expect(readFileSync(file, 'utf8')).toBe('v2\n')
  }, 20_000)

  test('reminders are listed, cancelled, and fired into their topic', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${proxyUrl}${path}`, { method: 'POST', body: JSON.stringify(body) })
    const later = await post('/remind', { topic: '42', at: new Date(Date.now() + 3_600_000).toISOString(), text: 'later' })
    expect(later.status).toBe(200)
    const { id } = await later.json()
    const listed = await fetch(`${proxyUrl}/reminders?topic=42`).then(r => r.json())
    expect(listed.reminders.map((r: { id: string }) => r.id)).toContain(id)
    expect((await post('/reminder/cancel', { topic: '42', id })).status).toBe(200)

    expect((await post('/remind', { topic: '42', at: new Date(Date.now() + 1_000).toISOString(), text: 'stretch' })).status).toBe(200)
    await until('the reminder to fire', () =>
      calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 42 && c.body.text === '⏰ stretch'), 25_000)
    const left = await fetch(`${proxyUrl}/reminders?topic=42`).then(r => r.json())
    expect(left.reminders).toEqual([])
  }, 30_000)

  const said = (thread: number, pattern: RegExp) =>
    calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === thread && pattern.test(c.body.text))

  test('/localgen locks a fresh topic: a prompt becomes a photo, and its commands answer for the harness', async () => {
    send(50, '/localgen pics')
    await until('the localgen lock', () => said(50, /Locked this topic to qwen-image/))
    send(50, 'a red cube steps:2 seed:7')
    const asked = await until('the image request', () => generations[0])
    expect([asked.prompt, asked.steps, asked.seed]).toEqual(['a red cube', 2, 7])
    await until('the photo', () => calls.find(c => c.method === 'sendPhoto'))
    send(50, '/model')
    await until('the model status', () => said(50, /Harness: localgen \(locked\)/))
    send(50, '/usage')
    await until('the usage answer', () => said(50, /localgen runs on the local qwen-image server; there is no quota/))
    send(50, '/relaunch')
    await until('the relaunch answer', () => said(50, /localgen runs no agent; there is nothing to relaunch/))
    expect(spawns().some(s => s.session.endsWith('-50'))).toBeFalse()
  }, 30_000)

  test('/antigravity with the harness switched off says so and locks nothing', async () => {
    send(51, '/antigravity')
    await until('the disabled answer', () =>
      calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 51 && c.body.text === ANTIGRAVITY_DISABLED_MESSAGE))
  }, 20_000)

  test('/localcode locks a fresh topic to OpenCode in Herdr, types turns into it, and relaunches the same session', async () => {
    send(60, '/localcode')
    await until('the OpenCode lock', () => said(60, /Locked this topic to OpenCode .* Session: ses_fake1\./), 30_000)
    const herdrCalls = () => readFileSync(join(home, 'fake', 'herdr.calls'), 'utf8')
    send(60, 'hello qwen')
    await until('the turn typed into the pane', () => /pane send-text p1 [\s\S]*hello qwen/.test(herdrCalls()))
    send(60, '/relaunch')
    await until('the relaunch answer', () => said(60, /(Relaunched OpenCode in Herdr with the same session|relaunch is queued[\s\S]*keep session) ses_fake1/), 30_000)
    const resumed = await until('the pane resumed with -s', () => {
      const panes: { label: string; argv: string[] }[] = JSON.parse(readFileSync(join(home, 'fake', 'herdr.json'), 'utf8')).panes
      return panes.find(p => p.argv.includes('-s') && p.argv.includes('ses_fake1'))
    }, 40_000)
    expect(resumed.label).toMatch(/^oc-.*-60$/)
    expect(spawns().some(s => s.session.endsWith('-60'))).toBeFalse()
  }, 90_000)

  test('the model picker walks provider, model, effort and Ultracode, and the topic restarts on that route', async () => {
    const first = spawns().find(s => s.session === 'claude-42')!
    const edits = () => calls.filter(c => c.method === 'editMessageText')
    send(42, '/model')
    const picker = await until('the provider picker', () =>
      calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 42 && /Choose a provider/.test(c.body.text)))
    expect(buttons(picker).map(b => b.callback_data)).toContain('tgroute:p:a:m:42')

    let seen = edits().length
    press(42, 'tgroute:p:a:m:42')
    const models = await until('the model list', () => edits().length > seen && edits().at(-1))
    const sonnet = buttons(models).find(b => b.text.startsWith('Sonnet'))!
    seen = edits().length
    press(42, sonnet.callback_data)
    const efforts = await until('the effort list', () => edits().length > seen && edits().at(-1))
    const high = buttons(efforts).find(b => b.callback_data.endsWith(':high'))!
    seen = edits().length
    press(42, high.callback_data)
    const ultracode = await until('the Ultracode choice', () => edits().length > seen && edits().at(-1))
    seen = edits().length
    press(42, buttons(ultracode).find(b => b.callback_data.endsWith(':0'))!.callback_data)
    const done = await until('the route answer', () => edits().length > seen && edits().at(-1))
    expect(done.body.text).toMatch(/sonnet/i)

    // A busy Claude switches at its next poll, the observable end of its turn
    if (/Queued/.test(done.body.text)) {
      await fetch(`${proxyUrl}/poll?topic=42`)
    }
    const restarted = await until('topic 42 restarted on Sonnet', () =>
      spawns().filter(s => s.session === 'claude-42').find(s => s.env.TG_MODEL === 'sonnet'))
    expect(restarted.env.TG_EFFORT).toBe('high')
    expect(restarted.env.TG_RESUME).toBe('1')
    expect(restarted.env.TG_CLAUDE_SESSION_ID).toBe(first.env.TG_CLAUDE_SESSION_ID)
    expect(registry()['42'].route).toMatchObject({ provider: 'anthropic', model: 'sonnet', effort: 'high', ultracode: false })

    send(42, '/usage')
    await until('the usage answer', () =>
      calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 42 && /^Provider usage/.test(c.body.text)))
  }, 40_000)

  test('a usage limit fails over to Fable, both resets are announced, and switch-back restores the route', async () => {
    const said43 = (pattern: RegExp) =>
      calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 43 && pattern.test(c.body.text))
    const limited = await fetch(`${proxyUrl}/rate-limit`, {
      method: 'POST',
      body: JSON.stringify({ topic: '43', error: 'rate_limit', reset_at: Math.floor(Date.now() / 1000) + 11 }),
    }).then(r => r.json())
    expect(limited.fallback).toMatchObject({ provider: 'anthropic', model: 'fable' })
    const notice = await until('the failover notice', () => said43(/reached its usage limit/))
    expect(buttons(notice).map(b => b.callback_data)).toContain('tgroute:return:a:43')
    await until('topic 43 resumed on Fable', () =>
      spawns().filter(s => s.session === 'claude-resumed-43').find(s => s.env.TG_MODEL === 'fable'))
    expect(registry()['43'].exhausted_routes[0].model).toBe('claude-opus-5-5')

    // The provider's own window resets: its timer offers the way back
    await fetch(`${proxyUrl}/capacity`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'anthropic', windows: [{ name: '5h', availability: 'exhausted', used_percent: 100, resets_at: Date.now() + 1_000 }] }),
    })
    await until('the provider reset notice', () => said43(/is available again/), 15_000)
    // The model's reported reset: its own timer offers the way back too
    await until('the fallback return offer', () => said43(/should be available again/), 20_000)

    press(43, 'tgroute:return:a:43')
    const answer = await until('the switch-back answer', () =>
      calls.find(c => c.method === 'editMessageText' && /(Now using|Queued) Anthropic · claude-opus-5-5/.test(c.body.text)))
    if (/Queued/.test(answer.body.text)) await fetch(`${proxyUrl}/poll?topic=43`)
    await until('topic 43 back on Opus 5.5', () =>
      spawns().filter(s => s.session === 'claude-resumed-43').slice(-1).find(s => s.env.TG_MODEL === 'claude-opus-5-5'))
    expect(registry()['43'].exhausted_routes ?? []).toEqual([])
  }, 60_000)

  test('a topic bound to a missing conversation is told so and starts nothing', async () => {
    send(44, 'hello?')
    const notice = await until('the missing-conversation notice', () =>
      calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === 44 && /no longer exists/.test(c.body.text)))
    expect(notice.body.chat_id).toBe(GROUP)
    expect(spawns().some(s => s.session.endsWith('-44'))).toBeFalse()
  }, 20_000)

  test('/relaunch restarts a topic on its same conversation with a nudge, once per window', async () => {
    const before = spawns().filter(s => s.session === 'claude-42').length
    send(42, '/relaunch')
    await until('the relaunch ack', () => said(42, /relaunching this topic's agent: same conversation/))
    const again = await until('topic 42 to respawn', () => spawns().filter(s => s.session === 'claude-42')[before])
    expect(again.env.TG_RESUME).toBe('1')
    expect(again.env.TG_CLAUDE_SESSION_ID).toBe(registry()['42'].claude_session_id)
    // Earlier tests' turns for topic 42 are still queued ahead of the nudge
    let polled = await fetch(`${proxyUrl}/poll?topic=42`).then(r => r.json())
    for (let i = 0; i < 10 && polled.meta.relaunch !== '1'; i++) {
      polled = await fetch(`${proxyUrl}/poll?topic=42`).then(r => r.json())
    }
    expect(polled.meta.relaunch).toBe('1')
    expect(polled.content).toContain('the operator relaunched this session')
    send(42, '/relaunch')
    await until('the debounce answer', () => said(42, /already relaunching/))
  }, 20_000)

  test('/relaunch in a topic whose conversation is missing starts a new one', async () => {
    send(44, '/relaunch')
    await until('the relaunch ack', () => said(44, /\(22222222-[^)]*\) was missing on disk, so a new conversation was started/))
    const fresh = await until('topic 44 to spawn', () => spawns().find(s => s.session.endsWith('-44')))
    expect(fresh.env.TG_RESUME).toBe('')
    expect(fresh.env.TG_CLAUDE_SESSION_ID).not.toBe(MISSING)
  }, 20_000)

  test('a topic learns its name from Telegram, and a rename is kept for its next session', async () => {
    deliver(48, { forum_topic_created: { name: 'Build Bot', icon_color: 7322096 } })
    send(48, 'hi')
    await until('topic 48 to spawn under its name', () => spawns().find(s => s.session === 'claude-build-bot-48'))
    deliver(48, { forum_topic_edited: { name: 'Release' } })
    await until('the rename to persist', () => registry()['48']?.name === 'Release')
  }, 20_000)

  test('a "yes <id>" reply answers a pending permission prompt in its own topic', async () => {
    const asked = await fetch(`${proxyUrl}/permission-request`, {
      method: 'POST',
      body: JSON.stringify({ topic: '48', request_id: 'abcde', tool: 'Bash', input: 'ls' }),
    })
    expect(asked.status).toBe(200)
    const prompt = said(48, /^🔐 Permission: Bash\n\nls/)
    expect(buttons(prompt).map(b => b.text)).toEqual(['✅ Allow', '❌ Deny'])
    const reply = send(48, 'yes abcde')
    expect(await fetch(`${proxyUrl}/permission-poll?topic=48`).then(r => r.json())).toEqual({ request_id: 'abcde', behavior: 'allow' })
    await until('the reply to be marked', () =>
      calls.find(c => c.method === 'setMessageReaction' && c.body.message_id === reply && c.body.reaction[0].emoji === '✅'))
  }, 20_000)

  test('a reply is chunked into its thread, quoting only once; react and edit reach the group', async () => {
    const out = (path: string, body: unknown) =>
      fetch(`${proxyUrl}${path}`, { method: 'POST', body: JSON.stringify(body) })
    const before = calls.length
    const sent = await out('/send', { chat_id: GROUP, topic: '42', text: 'x'.repeat(5000), reply_to: 7 })
    expect(sent.status).toBe(200)
    expect((await sent.json()).message_ids).toHaveLength(2)
    const chunks = calls.slice(before).filter(c => c.method === 'sendMessage')
    expect(chunks.map(c => c.body.message_thread_id)).toEqual([42, 42])
    expect(chunks.map(c => c.body.reply_parameters?.message_id)).toEqual([7, undefined])
    expect(chunks.map(c => c.body.text.length).reduce((a, b) => a + b)).toBe(5000)

    const picture = join(root, 'out.png')
    writeFileSync(picture, Buffer.from(PNG, 'base64'))
    expect((await out('/send', { chat_id: GROUP, topic: '42', files: [picture] })).status).toBe(200)
    expect(calls.at(-1)?.method).toBe('sendPhoto')

    expect((await out('/react', { chat_id: GROUP, message_id: 5, emoji: '👍' })).status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: 'setMessageReaction', body: expect.objectContaining({ message_id: 5 }) })
    const edited = await out('/edit', { chat_id: GROUP, message_id: 5, text: 'better' })
    expect(await edited.json()).toEqual({ message_id: 5 })
    expect(calls.at(-1)).toEqual({ method: 'editMessageText', body: expect.objectContaining({ text: 'better' }) })
  }, 20_000)

  test('outbound refuses another chat and the proxy\'s own state files', async () => {
    const out = (body: unknown) => fetch(`${proxyUrl}/send`, { method: 'POST', body: JSON.stringify(body) })
    const other = await out({ chat_id: '-100999', topic: '42', text: 'hi' })
    expect(other.status).toBe(500)
    expect((await other.json()).error).toContain('is not the configured group')
    const own = await out({ chat_id: GROUP, topic: '42', files: [join(state, 'registry.json')] })
    expect(own.status).toBe(500)
    expect((await own.json()).error).toContain('refusing to send channel state')
  }, 20_000)

  test('a topic created through the proxy is registered and in the directory at once', async () => {
    const created = await fetch(`${proxyUrl}/topic/create`, { method: 'POST', body: JSON.stringify({ name: 'Fresh Start' }) })
    expect(await created.json()).toEqual({ topic: '77', thread_id: 77, name: 'Fresh Start', harness: 'claude', slug: 'fresh-start' })
    expect(registry()['77']?.name).toBe('Fresh Start')
    const directory = await fetch(`${proxyUrl}/topics`).then(r => r.json())
    expect(directory.square).toBe('900')
    expect(directory.topics).toContainEqual({ slug: 'fresh-start', name: 'Fresh Start', topic: '77', live: false })
  }, 20_000)

  test('a malformed request is refused with a 400 naming the field', async () => {
    const res = await fetch(`${proxyUrl}/react`, {
      method: 'POST',
      body: JSON.stringify({ chat_id: GROUP, message_id: 'abc', emoji: '👍' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('message_id')
  })

  test('a topic on an older Claude Code waits out its turn, then resumes on the installed one', async () => {
    send(47, 'hi')
    const first = await until('topic 47 to spawn', () => spawns().find(s => s.session === 'claude-47'))
    await fetch(`${proxyUrl}/poll?topic=47`)
    // Claude Code's own record of the session; the test runner's pid stands in as a live process
    const sessions = join(home, '.claude', 'sessions')
    mkdirSync(sessions, { recursive: true })
    const record = (status: string) => writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: first.env.TG_CLAUDE_SESSION_ID, version: '2.1.300', status, statusUpdatedAt: Date.now(), startedAt: 1,
    }))
    record('busy')
    const log = () => readFileSync(join(root, 'proxy.log'), 'utf8')
    await until('the update to wait for the turn', () => /topic 47 .* runs claude 2\.1\.300 \(busy\); restarting onto 2\.1\.316 once idle/.test(log()))
    expect(spawns().filter(s => s.session === 'claude-47')).toHaveLength(1)
    record('idle')
    await until('the update notice', () => said(47, /updated to Claude Code 2\.1\.316: same conversation/))
    const again = await until('topic 47 to resume', () => spawns().filter(s => s.session === 'claude-47')[1])
    expect(again.env.TG_RESUME).toBe('1')
    expect(again.env.TG_CLAUDE_SESSION_ID).toBe(first.env.TG_CLAUDE_SESSION_ID)
    // Once per installed version, although the record still names the old one
    await Bun.sleep(1000)
    expect(spawns().filter(s => s.session === 'claude-47')).toHaveLength(2)
    expect(readFileSync(join(home, 'fake', 'live'), 'utf8').split('\n')).toContain('claude-47')
  }, 30_000)

  // Runs last: it stops the proxy.
  test('SIGTERM stops polling, removes the pid file, and exits cleanly', async () => {
    const pidFile = join(state, 'proxy.pid')
    expect(readFileSync(pidFile, 'utf8')).toBe(String(proxy.pid))
    proxy.kill('SIGTERM')
    expect(await proxy.exited).toBe(0)
    expect(existsSync(pidFile)).toBeFalse()
  }, 10_000)
})
