import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderPaneTurn } from '../shared/domain/inbound-delivery'
import { RELAUNCH_META, reminderMeta, SECRET_DROP_META, SQUARE_META } from '../shared/domain/turn-meta'
import { ROUTE } from '../http/routes'
import { parseRateLimit } from '../http/requests'
import { claudeSpawnEnv } from '../topics/claude-launch'

const hooks = join(import.meta.dir, '..', '..', 'hooks')

// Runs the real Stop hook on a transcript whose last user turn carries `meta`
// and whose answer never called a tool; returns whether the hook blocked the stop.
function blocksSilentStop(meta: Record<string, string>): boolean {
  const home = mkdtempSync(join(tmpdir(), 'tg-hook-'))
  const transcript = join(home, 'transcript.jsonl')
  const turn = renderPaneTurn({ content: 'hello', meta: { chat_id: '-1001', user: 'u', ...meta } })
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: turn } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answered in the transcript' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  const result = spawnSync('python3', [join(hooks, 'stop-reply-guard.py')], {
    input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false, session_id: 's' }),
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin:/opt/homebrew/bin' },
  })
  expect(result.status).toBe(0)
  return result.stdout.includes('"decision": "block"')
}

describe('stop-reply-guard.py and the proxy meta flags', () => {
  test('an operator message answered only in the transcript is blocked', () => {
    expect(blocksSilentStop({})).toBeTrue()
  })

  test('turns the proxy marks as needing no reply may end in silence', () => {
    expect(blocksSilentStop(SQUARE_META)).toBeFalse()
    expect(blocksSilentStop(SECRET_DROP_META)).toBeFalse()
    expect(blocksSilentStop(reminderMeta(false))).toBeFalse()
  })

  test('turns that ask for an answer still need one', () => {
    expect(blocksSilentStop(reminderMeta(true))).toBeTrue()
    expect(blocksSilentStop(RELAUNCH_META)).toBeTrue()
  })
})

describe('Python hooks and the proxy routes', () => {
  test('the capacity hook keeps the latest quota windows in a 0600 file, replacing only its own provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'))
    const file = join(dir, 'crook', 'usage.json')
    const run = (stdin: string) => spawnSync('/usr/bin/python3', [join(hooks, 'provider-capacity-status.py')], {
      input: stdin, encoding: 'utf8', env: { HOME: dir, PATH: '/usr/bin:/bin', CROOK_USAGE_FILE: file, TG_MODEL: 'claude-opus-5-5' },
    })
    const status = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 1793600000 }, seven_day: { used_percentage: 100 } } })
    mkdirSync(join(dir, 'crook'))
    writeFileSync(file, JSON.stringify({ providers: { openai: { windows: [], observed_at: 1 } } }))
    expect(run(status).stdout).toBe('Claude · anthropic · claude-opus-5-5\n')
    const kept = JSON.parse(readFileSync(file, 'utf8'))
    expect(kept.providers.openai).toEqual({ windows: [], observed_at: 1 })
    expect(kept.providers.anthropic).toEqual({
      windows: [
        { name: '5 hour', used_percent: 42, availability: 'available', resets_at: 1793600000000 },
        { name: '7 day', used_percent: 100, availability: 'exhausted' },
      ],
      observed_at: expect.any(Number),
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    writeFileSync(file, 'not json')
    run(status)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).providers)).toEqual(['anthropic'])
  })

  test('every route a hook posts to is one the proxy serves', () => {
    const served = new Set<string>(Object.values(ROUTE))
    for (const hook of ['rate-limit-failover.py', 'provider-capacity-status.py']) {
      const source = readFileSync(join(hooks, hook), 'utf8')
      const used = [...source.matchAll(/proxy\}?\s*\+?\s*"(\/[a-z/-]+)"|\{proxy\}(\/[a-z/-]+)/g)]
        .map(m => m[1] ?? m[2])
      expect(used.length).toBeGreaterThan(0)
      for (const route of used) expect([hook, served.has(route)]).toEqual([hook, true])
    }
  })
})

describe('rate-limit-failover.py and the proxy', () => {
  test('a limit report names the route the pane was launched on, as the proxy reads it', async () => {
    const bodies: unknown[] = []
    const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.json()); return Response.json({ ok: true }) } })
    const pane = claudeSpawnEnv({
      topic: '42', label: 'x', sessionName: 'claude-x-42', muxKind: 'tmux', spawnDir: '/tmp', proxyUrl: '', squareTopic: '',
      marketplace: 'm', route: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium', ultracode: false },
      auxiliaryModel: 'gpt-5.6-luna', claudeSessionId: 'c', resume: true, settingsPath: '', stopHook: '', failoverHook: '',
      capacityHook: '', providerProxyUrl: '',
    })
    const hook = Bun.spawn(['python3', join(hooks, 'rate-limit-failover.py')], {
      stdin: new Blob([JSON.stringify({ error: 'rate_limit', error_details: 'limit reached' })]),
      env: {
        HOME: mkdtempSync(join(tmpdir(), 'tg-hook-')),
        PATH: '/usr/bin:/bin:/opt/homebrew/bin',
        TELEGRAM_TOPIC_ID: '42',
        TELEGRAM_PROXY_URL: `http://127.0.0.1:${server.port}`,
        TG_PROVIDER: pane.TG_PROVIDER ?? '',
        TG_MODEL: pane.TG_MODEL ?? '',
      },
    })
    await hook.exited
    server.stop(true)
    expect(bodies).toHaveLength(1)
    expect(parseRateLimit(bodies[0]).ranOn).toEqual({ provider: 'codex', model: 'gpt-5.6-sol[1m]' })
  })
})
