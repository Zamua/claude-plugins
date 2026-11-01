import { describe, expect, test } from 'bun:test'
import { intentHarness, intentTopic } from './actions'
import { legacySwitchBack } from './pickers'

describe('intents', () => {
  test('name the topic a replayed button targets', () => {
    expect(intentTopic({ kind: 'models', provider: 'codex', reason: 'manual', topic: '42', page: 0 })).toBe('42')
    expect(intentTopic({ kind: 'antigravity-usage', topic: '7' })).toBe('7')
    expect(intentTopic({ kind: 'model', token: 'ab' })).toBeUndefined()
  })

  test('name the harness whose picker made the button', () => {
    expect(intentHarness({ kind: 'model', token: 'ab' })).toBe('claude')
    expect(intentHarness({ kind: 'dismiss' })).toBe('claude')
    expect(intentHarness({ kind: 'antigravity-model', token: 'ab' })).toBe('antigravity')
    expect(intentHarness({ kind: 'permission', behavior: 'allow', requestId: 'r' })).toBeUndefined()
  })
})

test('recovers the switch-back target from a reset picker posted before switch-back buttons', () => {
  expect(legacySwitchBack([
    { kind: 'model', token: 'deadbeef' },
    { kind: 'provider', provider: 'codex', reason: 'reset', topic: '2308' },
  ])).toEqual({ provider: 'codex', topic: '2308' })
  expect(legacySwitchBack([{ kind: 'provider', provider: 'codex', reason: 'manual', topic: '2308' }])).toBeUndefined()
  expect(legacySwitchBack([])).toBeUndefined()
})
