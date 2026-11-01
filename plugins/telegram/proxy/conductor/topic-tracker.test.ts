import { expect, test } from 'bun:test'
import type { TopicSummary } from './api'
import { topicTracker } from './topic-tracker'

const topic = (over: Partial<TopicSummary> = {}): TopicSummary =>
  ({ id: '7', name: 'build', kind: 'claude', title: null, route: null, state: 'idle', ...over })

function setup() {
  let listed = [topic()]
  let clock = Date.parse('2026-11-01T20:00:00.000Z')
  const changed: string[] = []
  const tracker = topicTracker({ topics: () => listed, store: { topicChanged: t => (changed.push(t), changed.length) }, now: () => clock })
  return { tracker, changed, set: (l: TopicSummary[]) => (listed = l), tick: (ms: number) => (clock += ms) }
}

test('the first look records quietly; a later change of state, title, name or route is news', () => {
  const { tracker, changed, set } = setup()
  tracker.refresh()
  expect(changed).toEqual([])
  tracker.refresh()
  expect(changed).toEqual([])
  for (const over of [{ state: 'working' as const }, { state: 'working' as const, title: 'Fix it' }, { state: 'working' as const, title: 'Fix it', name: 'ci' }]) {
    set([topic(over)])
    tracker.refresh()
  }
  expect(changed).toEqual(['7', '7', '7'])
})

test('a topic appearing later is news; since moves only when the state does', () => {
  const { tracker, changed, set, tick } = setup()
  tracker.refresh()
  expect(tracker.since('7')).toBeNull()
  tick(1000)
  set([topic({ state: 'working' }), topic({ id: '8' })])
  tracker.refresh()
  expect(changed).toEqual(['7', '8'])
  expect(tracker.since('7')).toBe('2026-11-01T20:00:01.000Z')
  tick(1000)
  set([topic({ state: 'working', title: 'Fix it' }), topic({ id: '8' })])
  tracker.refresh()
  expect(tracker.since('7')).toBe('2026-11-01T20:00:01.000Z')
})
