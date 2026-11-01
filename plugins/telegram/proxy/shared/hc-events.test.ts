import { expect, test } from 'bun:test'
import { applyHcEvent, hcSnapshot } from './hc-events'
import { parseHcTerminals } from './hc-terminals'

// Shaped as a real core sends them.
const created = {
  type: 'created', seq: 3, terminal: 't2',
  data: { address: 't2', state: 'live', labels: { session: 'claude-build-42', topic: '42' }, reported: false, status: null, title: '', cols: 200 },
}

test('a snapshot and the events after it keep each terminal as terminal.list would describe it', () => {
  const known = hcSnapshot({ seq: 2, terminals: [{ address: 't1', state: 'live', labels: { session: 's1' }, reported: true, status: { state: 'done' } }] })
  expect(applyHcEvent(known, created)).toBe('t2')
  applyHcEvent(known, { type: 'title', seq: 4, terminal: 't2', data: { title: 'Fix the flaky test' } })
  applyHcEvent(known, { type: 'foreground', seq: 5, terminal: 't2', data: { name: 'claude', pid: 9, argv: ['claude'], cwd: '/' } })
  applyHcEvent(known, { type: 'status', seq: 6, terminal: 't2', data: { records: {}, reported: true, status: { app: 'claude-code', state: 'working' } } })
  expect(parseHcTerminals({ terminals: [...known.values()] })).toEqual([
    { state: 'live', address: 't1', session: 's1', status: 'done' },
    { state: 'live', address: 't2', session: 'claude-build-42', status: 'working', foreground: 'claude', title: 'Fix the flaky test', cols: 200 },
  ])
  applyHcEvent(known, { type: 'finished', seq: 7, terminal: 't2', data: { exit_code: 0, reason: 'exited', signal: null, finished_ms: 1 } })
  expect(parseHcTerminals({ terminals: [known.get('t2')] })).toEqual([{ state: 'finished', address: 't2', session: 'claude-build-42' }])
  expect(applyHcEvent(known, { type: 'removed', seq: 8, terminal: 't2', data: {} })).toBe('t2')
  expect([...known.keys()]).toEqual(['t1'])
})

test('an event it cannot read, or for a terminal it never saw, changes nothing', () => {
  const known = hcSnapshot({ seq: 1, terminals: [] })
  expect(applyHcEvent(known, { type: 'status', terminal: 't9', data: { status: { state: 'idle' } } })).toBeUndefined()
  expect(applyHcEvent(known, null)).toBeUndefined()
  expect(applyHcEvent(known, { type: 'removed', terminal: 't9' })).toBeUndefined()
  expect(hcSnapshot('nonsense').size).toBe(0)
})

test('a turn event names the status in a state field, which never touches the terminal\'s own state', () => {
  const known = hcSnapshot({ seq: 1, terminals: [created.data] })
  applyHcEvent(known, { type: 'turn', seq: 2, terminal: 't2', data: { state: 'idle', turn: 1 } })
  expect(known.get('t2')).toMatchObject({ state: 'live', turn: 1 })
  expect(applyHcEvent(known, { type: 'doc', seq: 3, terminal: 't2', data: { state: 'x' } })).toBeUndefined()
  expect(known.get('t2')?.state).toBe('live')
})
