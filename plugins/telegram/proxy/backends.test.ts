import { describe, expect, test } from 'bun:test'
import {
  backendFor, claudeBackend, claudeTranscriptTurns, opencodeBackend, opencodeHandoffSeed,
  opencodeKickoff, parseOpencodeExport, renderDelta,
} from './backends'
import type { SpawnSpec } from './backends'

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
  topic: '34',
  label: 'hostthis',
  sessionName: 'claude-hostthis-34',
  muxKind: 'herdr',
  spawnDir: '/Users/zamua/Dropbox/workspace/macmini',
  proxyUrl: 'http://localhost:8790',
  squareTopic: '123',
  marketplace: 'plugin:telegram@zamua',
  model: 'fable',
  claudeSessionId: 'abc-123',
  resume: false,
  settingsPath: '/settings.json',
  stopHook: '/hooks/stop-reply-guard.py',
  failoverHook: '/hooks/rate-limit-failover.py',
  kickoff: '',
  opencodeSessionId: '',
  opencodeBin: '/etc/profiles/per-user/zamua/bin/opencode',
  opencodeModel: 'opencode-go/glm-5.3-flash',
  opencodeVariant: '',
  opencodeSeed: '',
  ...over,
})

describe('claudeBackend.spawnEnv', () => {
  test('first spawn (mint): the exact env block ensureSession used to build inline', () => {
    const env = claudeBackend.spawnEnv(spec())
    expect(env.TG_SESSION).toBe('claude-hostthis-34')
    expect(env.TG_MUX).toBe('herdr')
    expect(env.TG_SPAWN_DIR).toBe('/Users/zamua/Dropbox/workspace/macmini')
    expect(env.TELEGRAM_TOPIC_ID).toBe('34')
    expect(env.TELEGRAM_PROXY_URL).toBe('http://localhost:8790')
    expect(env.TG_MARKETPLACE).toBe('plugin:telegram@zamua')
    expect(env.TG_SETTINGS).toBe('/settings.json')
    expect(env.TG_HOOK).toBe('/hooks/stop-reply-guard.py')
    expect(env.TG_FAILOVER_HOOK).toBe('/hooks/rate-limit-failover.py')
    expect(env.TG_MODEL).toBe('fable')
    expect(env.TG_CLAUDE_SESSION_ID).toBe('abc-123')
    expect(env.TG_RESUME).toBe('')
  })

  test('resume spawn flags TG_RESUME=1 and keeps every other var', () => {
    const env = claudeBackend.spawnEnv(spec({ resume: true }))
    expect(env.TG_RESUME).toBe('1')
    expect(env.TG_CLAUDE_SESSION_ID).toBe('abc-123')
    expect(env.TG_KICKOFF).toBe(claudeBackend.spawnEnv(spec()).TG_KICKOFF)
  })

  test('the pinned fallback model wins TG_MODEL (the --model FLAG overrides even on resume)', () => {
    expect(claudeBackend.spawnEnv(spec({ model: 'opus', resume: true })).TG_MODEL).toBe('opus')
  })

  test('kickoff text: startup notice + working dir + em-dash rule, byte-for-byte shape', () => {
    const env = claudeBackend.spawnEnv(spec())
    expect(env.TG_KICKOFF).toBe(
      `SYSTEM STARTUP NOTICE (not a user message): you are the Claude for the hostthis topic. ` +
        `Do NOT greet or send anything yet. Wait for the first real user message - it will arrive as a ` +
        `<channel> turn - and respond to THAT via the telegram MCP (it targets this topic). Your working ` +
        `dir is /Users/zamua/Dropbox/workspace/macmini. IMPORTANT: other Claudes may be running concurrently on this same machine, ` +
        `un-sandboxed and possibly in overlapping dirs, so be careful with destructive or global actions ` +
        `and with shared state, and do not assume you are alone. ` +
        `WRITING STYLE: never use em dashes in anything you write - not in messages to the user, ` +
        `not in code comments, commit messages, or docs. Use a colon, parentheses, or two sentences.` +
        ` THE SQUARE: a shared #square topic hosts agent-to-agent conversations. To ask a peer Claude ` +
        `for help, use the square_tag tool (see list_topics for peers); continue conversations with ` +
        `square_reply using the conv + reply_token from the notification meta. Norms: tag a peer only ` +
        `when you genuinely need them; every message must move the work forward; do long work in shared ` +
        `files and post summaries + paths; a closing courtesy is fine but never reply to a courtesy with ` +
        `a courtesy; if a square notification warrants no reply, do nothing - silence politely ends a ` +
        `conversation and is explicitly sanctioned there (the reply requirement applies to YOUR topic's ` +
        `user messages, not square deliveries).`,
    )
  })

  test('square section omitted when the square is disabled', () => {
    const env = claudeBackend.spawnEnv(spec({ squareTopic: '' }))
    expect(env.TG_KICKOFF).not.toContain('THE SQUARE')
  })
})

describe('opencodeBackend.spawnEnv', () => {
  test('minting and resumed spawns both carry the seed (a handoff delta rides until acked)', () => {
    const mint = opencodeBackend.spawnEnv(spec({ sessionName: 'oc-hostthis-34', opencodeSeed: 'SEED TEXT' }))
    expect(mint.TG_BACKEND).toBe('opencode')
    expect(mint.TG_OC_SESSION_ID).toBe('')
    expect(mint.TG_OC_SEED).toBe('SEED TEXT')
    expect(mint.TG_OC_BIN).toBe('/etc/profiles/per-user/zamua/bin/opencode')
    expect(mint.TG_OC_MODEL).toBe('opencode-go/glm-5.3-flash')
    expect(mint.TG_OC_VARIANT).toBe('')
    expect(mint.TG_SESSION).toBe('oc-hostthis-34')
    // Shared vars match the claude backend's shape exactly.
    expect(mint.TG_MUX).toBe('herdr')
    expect(mint.TELEGRAM_TOPIC_ID).toBe('34')
    expect(mint.TELEGRAM_PROXY_URL).toBe('http://localhost:8790')
    expect(mint.TG_SPAWN_DIR).toBe('/Users/zamua/Dropbox/workspace/macmini')

    const resumed = opencodeBackend.spawnEnv(spec({ opencodeSessionId: 'ses_x', opencodeSeed: 'SEED TEXT' }))
    expect(resumed.TG_OC_SESSION_ID).toBe('ses_x')
    expect(resumed.TG_OC_SEED).toBe('SEED TEXT')

    // No seed pending: both are empty.
    expect(opencodeBackend.spawnEnv(spec()).TG_OC_SEED).toBe('')
    expect(opencodeBackend.spawnEnv(spec({ opencodeSessionId: 'ses_x' })).TG_OC_SEED).toBe('')
  })

  test('variant passes through when set', () => {
    expect(opencodeBackend.spawnEnv(spec({ opencodeVariant: 'high' })).TG_OC_VARIANT).toBe('high')
  })
})

describe('backendFor', () => {
  test('undefined and claude resolve to claude (registry back-compat)', () => {
    expect(backendFor(undefined)).toBe(claudeBackend)
    expect(backendFor('claude')).toBe(claudeBackend)
    expect(backendFor('opencode')).toBe(opencodeBackend)
  })
})

describe('claudeTranscriptTurns', () => {
  const jsonl = [
    JSON.stringify({ type: 'file-history-snapshot', sessionId: 'x' }),
    JSON.stringify({ type: 'user', message: { content: 'hello there' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi!' }, { type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } }),
    JSON.stringify({ type: 'user', isMeta: true, message: { content: 'system meta line' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: 'subagent turn' } }),
    'not json at all',
    JSON.stringify({ type: 'user', message: { content: 'final question' } }),
  ].join('\n')

  test('keeps user/assistant text turns, skips tools, meta, sidechains, torn lines', () => {
    expect(claudeTranscriptTurns(jsonl, 50)).toEqual([
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'hi!' },
      { role: 'user', text: 'final question' },
    ])
  })

  test('keeps the newest maxTurns', () => {
    expect(claudeTranscriptTurns(jsonl, 2)).toEqual([
      { role: 'assistant', text: 'hi!' },
      { role: 'user', text: 'final question' },
    ])
  })
})

describe('parseOpencodeExport', () => {
  const exported = JSON.stringify({
    info: { id: 'ses_x', model: { id: 'glm-5.3-flash', providerID: 'opencode-go' } },
    messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'first prompt' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'step-start' }, { type: 'text', text: 'the answer' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'tool', state: {} }] },
      { info: { role: 'user' }, parts: [{ type: 'file', filename: 'x.png' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'latest prompt' }] },
    ],
  })

  test('text parts only, roles from message info, newest kept', () => {
    expect(parseOpencodeExport(exported, 50)).toEqual([
      { role: 'user', text: 'first prompt' },
      { role: 'assistant', text: 'the answer' },
      { role: 'user', text: 'latest prompt' },
    ])
    expect(parseOpencodeExport(exported, 1)).toEqual([{ role: 'user', text: 'latest prompt' }])
  })

  test('a torn/foreign payload yields no turns instead of throwing', () => {
    expect(parseOpencodeExport('not json', 10)).toEqual([])
    expect(parseOpencodeExport('{}', 10)).toEqual([])
  })
})

describe('renderDelta', () => {
  const turns = [
    { role: 'user' as const, text: 'one' },
    { role: 'assistant' as const, text: 'two' },
    { role: 'user' as const, text: 'three' },
  ]

  test('oldest first, no marker when everything fits', () => {
    expect(renderDelta(turns, 1000)).toBe('[user]\none\n\n[assistant]\ntwo\n\n[user]\nthree')
  })

  test('drops the OLDEST turns until it fits, then marks the omission', () => {
    const out = renderDelta(turns, 20)
    expect(out).toBe('[...earlier turns omitted...]\n\n[user]\nthree')
  })

  test('an empty turn list renders a marker, never an empty seed', () => {
    expect(renderDelta([], 100)).toBe('(no conversation turns recovered)')
  })
})

describe('opencode handoff framing', () => {
  test('kickoff is a startup notice, not a greeting', () => {
    const t = opencodeKickoff({ label: 'gpu', spawnDir: '/tmp', squareTopic: '' })
    expect(t).toContain('you are the assistant for the gpu topic')
    expect(t).toContain('running in opencode')
    expect(t).toContain('never use em dashes')
  })

  test('handoff seed frames the delta with the takeover context', () => {
    const t = opencodeHandoffSeed({ label: 'gpu', spawnDir: '/tmp', squareTopic: '' }, '[user]\nhi\n[assistant]\nhello')
    expect(t).toContain('taking over the Telegram topic "gpu"')
    expect(t).toContain('usage limit')
    expect(t).toContain('--- PRIOR CONVERSATION')
    expect(t).toContain('[user]\nhi')
  })
})
