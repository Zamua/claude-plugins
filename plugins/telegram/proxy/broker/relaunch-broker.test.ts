import { expect, test } from 'bun:test'
import type { TargetFacts } from './domain/relaunch'
import { createRelaunchBroker } from './relaunch-broker'
import type { LedgerRecord } from './relaunch-broker'

const ROOT_PID = 500

function setup() {
  const tree: Record<string, TargetFacts> = {
    general: { parent: null, running: true, idle: true },
    '34': { parent: 'general', running: true, idle: true },
    '35': { parent: 'general', running: true, idle: false },
    '36': { parent: 'general', running: false, idle: false },
  }
  const events: string[] = []
  const ledger: LedgerRecord[] = []
  const broker = createRelaunchBroker({
    root: 'general',
    rootAgentPid: () => ROOT_PID,
    facts: topic => tree[topic],
    relaunch: async topic => void events.push(`relaunch ${topic}`),
    callerTopic: ancestry => (ancestry.includes(600) ? '35' : undefined),
    record: entry => {
      ledger.push(entry)
      events.push(`ledger ${entry.kind} ${entry.target ?? (entry.targets as string[]).join(',')}`)
    },
    log: () => {},
    staggerMs: 0,
  })
  return { broker, tree, events, ledger }
}

test('the root relaunches a mixed list: each outcome is recorded before anything runs', async () => {
  const { broker, events, ledger } = setup()
  const answer = await broker.request(700, [700, 650, ROOT_PID, 1], ['34', '35', '36', '99', 'general', '34'])
  expect(answer).toEqual({
    caller: 'general',
    results: [
      { topic: '34', outcome: 'applied' },
      { topic: '35', outcome: 'queued' },
      { topic: '36', outcome: 'no_agent' },
      { topic: '99', outcome: 'refused', reason: 'unknown topic' },
      { topic: 'general', outcome: 'refused', reason: 'not under general' },
    ],
  })
  expect(events.slice(0, 2)).toEqual(['ledger relaunch 34', 'relaunch 34'])
  expect(ledger.map(e => [e.target, e.outcome, e.caller_pid])).toEqual([
    ['34', 'applied', 700], ['35', 'queued', 700], ['36', 'no_agent', 700], ['99', 'refused', 700], ['general', 'refused', 700],
  ])
})

test('a caller off the root\'s process tree is refused and recorded, naming its topic', async () => {
  const { broker, events, ledger } = setup()
  const answer = await broker.request(610, [610, 600, 1], ['34'])
  expect(answer.results).toEqual([{ topic: '34', outcome: 'refused', reason: "only general's agent may relaunch topics" }])
  expect(answer.caller).toBe('35')
  expect(ledger).toEqual([{ kind: 'relaunch_refused', caller_pid: 610, caller_topic: '35', targets: ['34'], reason: "only general's agent may relaunch topics" }])
  expect(events.filter(e => e.startsWith('relaunch'))).toEqual([])
})

test('a caller the kernel cannot name is refused', async () => {
  const { broker, ledger } = setup()
  expect((await broker.request(undefined, [], ['34'])).results[0].outcome).toBe('refused')
  expect(ledger[0]).toMatchObject({ kind: 'relaunch_refused', caller_pid: null, caller_topic: null })
})

test('a queued relaunch runs once its turn ends, and is dropped if its agent stops first', async () => {
  const { broker, tree, events, ledger } = setup()
  await broker.request(700, [700, ROOT_PID], ['35', '34'])
  tree['34'] = { ...tree['34'], idle: false }
  await broker.request(700, [700, ROOT_PID], ['34'])
  await broker.sweep()
  expect(broker.queued()).toEqual(new Set(['35', '34']))
  tree['35'] = { ...tree['35'], idle: true }
  tree['34'] = { ...tree['34'], running: false }
  await broker.sweep()
  expect(broker.queued()).toEqual(new Set())
  expect(events.filter(e => e.startsWith('relaunch'))).toEqual(['relaunch 34', 'relaunch 35'])
  expect(ledger.at(-1)).toEqual({ kind: 'relaunch', caller: 'general', target: '35', outcome: 'applied', queued: true })
})

test('relaunches are spaced out, one at a time, whether a list or the sweep asks', async () => {
  let clock = 0
  const started: Array<[string, number]> = []
  const tree: Record<string, TargetFacts> = Object.fromEntries(
    ['a', 'b', 'c', 'd'].map(t => [t, { parent: 'general', running: true, idle: t !== 'd' }]),
  )
  const broker = createRelaunchBroker({
    root: 'general',
    rootAgentPid: () => ROOT_PID,
    facts: topic => tree[topic],
    relaunch: async topic => void started.push([topic, clock]),
    callerTopic: () => undefined,
    record: () => {},
    log: () => {},
    staggerMs: 3_000,
    now: () => clock,
    sleep: async ms => void (clock += ms),
  })
  await broker.request(700, [ROOT_PID], ['a', 'b', 'c', 'd'])
  tree.d = { ...tree.d, idle: true }
  clock += 1_000
  await broker.sweep()
  expect(started).toEqual([['a', 0], ['b', 3_000], ['c', 6_000], ['d', 9_000]])
})
