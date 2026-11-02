import { expect, test } from 'bun:test'
import type { HcTerminal } from '../shared/hc-terminals'
import { activitySource } from './activity-source'

const NOW = Date.parse('2026-11-02T03:00:00.000Z')
const live = (status: 'working' | 'blocked' | 'idle'): HcTerminal => ({ state: 'live', address: `t-${status}`, status })
const toolUse = (id: string, name: string, input: object) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-02T02:59:50.000Z', message: { content: [{ type: 'tool_use', id, name, input }] } })

function setup() {
  const terminals: Record<string, HcTerminal | undefined> = { '42': live('working'), '43': live('working'), '44': live('idle') }
  const tails: Record<string, string[]> = { s42: [toolUse('a', 'Bash', { command: 'bun test' })], s43: [], s44: [toolUse('b', 'Read', { file_path: '/x' })] }
  let clock = NOW
  const screens: string[] = []
  let changes = 0
  const source = activitySource({
    topics: () => Object.keys(terminals),
    terminal: topic => terminals[topic],
    sessionId: topic => `s${topic}`,
    transcriptTail: id => tails[id],
    screen: async address => (screens.push(address), '✳ Pondering… (12s · ↓ 1.2k tokens)\n'),
    now: () => clock,
  })
  source.onChange(() => changes++)
  return { source, terminals, tails, screens, tick: (ms: number) => (clock += ms), changes: () => changes }
}

test('a working topic shows its tool in flight, else its spinner; an idle one shows nothing', async () => {
  const h = setup()
  await h.source.refresh()
  expect(h.source.activity('42')).toEqual({ label: 'Bash: bun test', since: '2026-11-02T02:59:50.000Z' })
  expect(h.source.activity('43')).toEqual({ label: 'Pondering…', since: '2026-11-02T02:59:48.000Z', tokens: 1200 })
  expect(h.source.activity('44')).toBeUndefined()
  expect(h.screens).toEqual(['t-working'])
  expect(h.changes()).toBe(1)
})

test('listeners hear a changed label, not a moving spinner, whose first start holds', async () => {
  const h = setup()
  await h.source.refresh()
  h.tick(5_000)
  await h.source.refresh()
  expect(h.changes()).toBe(1)
  expect(h.source.activity('43')?.since).toBe('2026-11-02T02:59:48.000Z')
  h.tails.s42 = [...h.tails.s42, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }), toolUse('c', 'Grep', { pattern: 'TODO' })]
  await h.source.refresh()
  expect([h.changes(), h.source.activity('42')?.label]).toEqual([2, 'Grep: TODO'])
})

test('a topic that stops working or leaves loses its activity, with one change', async () => {
  const h = setup()
  await h.source.refresh()
  h.terminals['42'] = live('idle')
  delete h.terminals['43']
  await h.source.refresh()
  expect([h.source.activity('42'), h.source.activity('43'), h.changes()]).toEqual([undefined, undefined, 2])
})
