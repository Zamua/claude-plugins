import { describe, expect, test } from 'bun:test'
import { callbackHarness, callbackTopic, decodeCallback, encodeCallback, legacySwitchBack } from './telegram-callback'
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

  test('names the topic a replayed button targets', () => {
    expect(callbackTopic({ kind: 'models', provider: 'codex', reason: 'manual', topic: '42', page: 0 })).toBe('42')
    expect(callbackTopic({ kind: 'antigravity-usage', topic: '7' })).toBe('7')
    expect(callbackTopic({ kind: 'model', token: 'ab' })).toBeUndefined()
  })

  test('ties route pickers to the harness that emits them', () => {
    expect(callbackHarness({ kind: 'model', token: 'ab' })).toBe('claude')
    expect(callbackHarness({ kind: 'dismiss' })).toBe('claude')
    expect(callbackHarness({ kind: 'antigravity-model', token: 'ab' })).toBe('antigravity')
    expect(callbackHarness({ kind: 'permission', behavior: 'allow', requestId: 'r' })).toBeUndefined()
  })

  test('recovers the switch-back target from a reset keyboard posted before switch-back buttons', () => {
    const message = {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Switch back to GPT-5.6 Sol', callback_data: 'tgroute:m:deadbeef' }],
          [{ text: 'Choose ChatGPT / Codex model', callback_data: 'tgroute:p:c:r:2308' }],
        ],
      },
    }
    expect(legacySwitchBack(message)).toEqual({ provider: 'codex', topic: '2308' })
    expect(legacySwitchBack({ reply_markup: { inline_keyboard: [] } })).toBeUndefined()
  })
})
