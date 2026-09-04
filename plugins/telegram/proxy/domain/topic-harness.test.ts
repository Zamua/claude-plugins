import { describe, expect, test } from 'bun:test'
import { callbackBelongsToHarness, callbackTopicTarget, topicHarness } from './topic-harness'

describe('topic harness lock', () => {
  test('recognizes the separate callback namespaces', () => {
    expect(callbackBelongsToHarness('antigravity', 'agroute:model:abc')).toBeTrue()
    expect(callbackBelongsToHarness('antigravity', 'tgroute:p:c:m')).toBeFalse()
    expect(callbackBelongsToHarness('claude', 'tgroute:model:abc')).toBeTrue()
    expect(callbackBelongsToHarness('claude', 'agroute:model:abc')).toBeFalse()
    expect(callbackBelongsToHarness('opencode', 'agroute:model:abc')).toBeFalse()
    expect(callbackBelongsToHarness('opencode', 'tgroute:model:abc')).toBeFalse()
    expect(callbackBelongsToHarness('opencode', 'tgauth:a:abc')).toBeTrue()
  })

  test('persists an explicit harness identity rather than inferring it from a model', () => {
    expect(topicHarness({ harness: 'antigravity' })).toBe('antigravity')
    expect(topicHarness({ harness: 'claude' })).toBe('claude')
    expect(topicHarness({ harness: 'opencode' })).toBe('opencode')
    expect(topicHarness({})).toBe('claude')
  })

  test('extracts explicit topic targets so forged cross-topic callbacks are rejectable', () => {
    expect(callbackTopicTarget('tgroute:p:c:m:42')).toBe('42')
    expect(callbackTopicTarget('tgroute:models:o:m:42:1')).toBe('42')
    expect(callbackTopicTarget('tgroute:return:a:42')).toBe('42')
    expect(callbackTopicTarget('agroute:models:42:0')).toBe('42')
    expect(callbackTopicTarget('agroute:usage:42')).toBe('42')
    expect(callbackTopicTarget('tgroute:m:opaque')).toBeUndefined()
  })
})
