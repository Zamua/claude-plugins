import { expect, test } from 'bun:test'
import { callerIsRoot, relaunchTarget } from './relaunch'
import type { TargetFacts } from './relaunch'

const tree: Record<string, TargetFacts> = {
  general: { parent: null, running: true, idle: true },
  '34': { parent: 'general', running: true, idle: true },
  '35': { parent: 'general', running: true, idle: false },
  '36': { parent: 'general', running: false, idle: false },
  w1: { parent: '35', running: true, idle: true },
}
const facts = (topic: string) => tree[topic]

test('the caller speaks for the root only with the root agent among its ancestors', () => {
  expect(callerIsRoot([900, 800, 700], 800)).toBeTrue()
  expect(callerIsRoot([900, 800], 700)).toBeFalse()
  expect(callerIsRoot([900], undefined)).toBeFalse()
})

test('each target under the root is relaunched now, at its turn\'s end, or not at all', () => {
  expect(['34', '35', '36', 'w1'].map(t => relaunchTarget(t, 'general', facts).outcome)).toEqual(['applied', 'queued', 'no_agent', 'applied'])
})

test('the root itself and unknown topics are refused', () => {
  expect(relaunchTarget('general', 'general', facts)).toEqual({ topic: 'general', outcome: 'refused', reason: 'not under general' })
  expect(relaunchTarget('99', 'general', facts)).toEqual({ topic: '99', outcome: 'refused', reason: 'unknown topic' })
})
