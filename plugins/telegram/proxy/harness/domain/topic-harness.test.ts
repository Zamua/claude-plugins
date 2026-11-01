import { describe, expect, test } from 'bun:test'
import { lockRefusal, topicHarness } from './topic-harness'
import type { LockRequest } from './topic-harness'

describe('topic harness lock', () => {
  test('persists an explicit harness identity rather than inferring it from a model', () => {
    expect(topicHarness({ harness: 'antigravity' })).toBe('antigravity')
    expect(topicHarness({ harness: 'claude' })).toBe('claude')
    expect(topicHarness({ harness: 'opencode' })).toBe('opencode')
    expect(topicHarness({ harness: 'localgen' })).toBe('localgen')
    expect(topicHarness({})).toBe('claude')
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
