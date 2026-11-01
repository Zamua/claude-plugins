import { describe, expect, test } from 'bun:test'
import { decodeCallback, encodeCallback } from './telegram-callback'
import type { Callback } from './telegram-callback'

const every: Callback[] = [
  { kind: 'permission', behavior: 'allow', requestId: 'abcde' },
  { kind: 'permission', behavior: 'deny', requestId: 'abcde' },
  { kind: 'providers', reason: 'quota', topic: '42' },
  { kind: 'provider', provider: 'codex', reason: 'reset', topic: 'general' },
  { kind: 'models', provider: 'opencode-go', reason: 'manual', topic: '42', page: 3 },
  { kind: 'model', token: 'deadbeef' },
  { kind: 'effort', token: 'deadbeef', effort: 'xhigh' },
  { kind: 'ultracode', token: 'deadbeef', on: true },
  { kind: 'ultracode', token: 'deadbeef', on: false },
  { kind: 'usage', topic: '42' },
  { kind: 'switch-back', provider: 'anthropic', topic: '1133' },
  { kind: 'dismiss' },
  { kind: 'antigravity-models', topic: '42', page: 0 },
  { kind: 'antigravity-model', token: 'cafe01' },
  { kind: 'antigravity-effort', token: 'cafe01', effort: 'high' },
  { kind: 'antigravity-usage', topic: '42' },
]

describe('Telegram callback codec', () => {
  test('every callback survives an encode-decode round trip', () => {
    for (const c of every) expect(decodeCallback(encodeCallback(c))).toEqual(c)
  })

  test('keeps decoding the strings already posted in chats', () => {
    expect(decodeCallback('tgroute:return:c:1133')).toEqual({ kind: 'switch-back', provider: 'codex', topic: '1133' })
    expect(decodeCallback('tgroute:p:o:q:general'))
      .toEqual({ kind: 'provider', provider: 'opencode-go', reason: 'quota', topic: 'general' })
    expect(decodeCallback('agroute:models:42:1')).toEqual({ kind: 'antigravity-models', topic: '42', page: 1 })
    expect(decodeCallback('tgperm:deny:req-1')).toEqual({ kind: 'permission', behavior: 'deny', requestId: 'req-1' })
  })

  test('rejects data no button emits', () => {
    for (const data of ['', 'tgroute:m:expired', 'tgroute:p:x:m:42', 'tgroute:e:ab:extreme', 'agroute:e:ab:xhigh', 'other']) {
      expect(decodeCallback(data)).toBeUndefined()
    }
  })

  test('refuses to encode data Telegram would reject', () => {
    expect(() => encodeCallback({ kind: 'usage', topic: 'x'.repeat(60) })).toThrow('64 bytes')
  })

})
