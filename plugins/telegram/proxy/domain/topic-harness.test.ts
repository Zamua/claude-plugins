import { describe, expect, test } from 'bun:test'
import { callbackBelongsToHarness, callbackTopicTarget, lockRefusal, topicHarness } from './topic-harness'
import type { LockRequest } from './topic-harness'

describe('topic harness lock', () => {
  test('recognizes the separate callback namespaces', () => {
    expect(callbackBelongsToHarness('antigravity', 'agroute:model:abc')).toBeTrue()
    expect(callbackBelongsToHarness('antigravity', 'tgroute:p:c:m')).toBeFalse()
    expect(callbackBelongsToHarness('claude', 'tgroute:model:abc')).toBeTrue()
    expect(callbackBelongsToHarness('claude', 'agroute:model:abc')).toBeFalse()
    expect(callbackBelongsToHarness('opencode', 'agroute:model:abc')).toBeFalse()
    expect(callbackBelongsToHarness('opencode', 'tgroute:model:abc')).toBeFalse()
    expect(callbackBelongsToHarness('opencode', 'tgauth:a:abc')).toBeTrue()
    expect(callbackBelongsToHarness('localgen', 'agroute:model:abc')).toBeFalse()
    expect(callbackBelongsToHarness('localgen', 'tgroute:model:abc')).toBeFalse()
  })

  test('persists an explicit harness identity rather than inferring it from a model', () => {
    expect(topicHarness({ harness: 'antigravity' })).toBe('antigravity')
    expect(topicHarness({ harness: 'claude' })).toBe('claude')
    expect(topicHarness({ harness: 'opencode' })).toBe('opencode')
    expect(topicHarness({ harness: 'localgen' })).toBe('localgen')
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

  describe('lockRefusal', () => {
    const fresh: LockRequest = {
      harness: 'opencode',
      byOperator: true,
      inSquare: false,
      current: 'claude',
      ownsClaudeConversation: false,
    }

    test('the operator may lock a fresh topic', () => {
      expect(lockRefusal(fresh)).toBeUndefined()
    })

    test('only the operator may lock, whatever else is true', () => {
      expect(lockRefusal({ ...fresh, byOperator: false })).toContain('Only the operator')
    })

    test('the square never takes a harness', () => {
      expect(lockRefusal({ ...fresh, inSquare: true })).toContain('square')
    })

    test('a topic locked to another harness names that harness and the command to use elsewhere', () => {
      const refusal = lockRefusal({ ...fresh, harness: 'localgen', current: 'antigravity' })
      expect(refusal).toContain('Antigravity')
      expect(refusal).toContain('run /localgen there')
    })

    test('a topic with a Claude conversation cannot be converted in place', () => {
      const refusal = lockRefusal({ ...fresh, harness: 'antigravity', ownsClaudeConversation: true })
      expect(refusal).toContain('Claude Code conversation')
      expect(refusal).toContain('run /antigravity there')
    })

    test('a topic already locked to the same harness is left to that harness', () => {
      expect(lockRefusal({ ...fresh, current: 'opencode' })).toBeUndefined()
    })
  })
})
