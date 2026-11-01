import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { trackApprovals } from './approvals'
import { ConductorStore } from './sqlite-store'

const screen = readFileSync(join(import.meta.dir, 'domain', 'testdata', 'permission-dialog.txt'), 'utf8')
const open: ConductorStore[] = []
afterEach(() => open.splice(0).forEach(s => s.close()))

function setup() {
  const store = new ConductorStore(mkdtempSync(join(tmpdir(), 'approvals-')))
  open.push(store)
  let blocked: { kind: string | null; msg: string } | undefined
  let shown = screen
  let clock = 1_000_000
  const lines: string[] = []
  const tracker = trackApprovals({
    store, topics: () => [{ id: '42' }, { id: '7' }],
    blocked: topic => (topic === '42' ? blocked : undefined),
    screen: async () => shown,
    log: line => void lines.push(line),
    now: () => clock,
  })
  return {
    store, tracker, lines,
    block: (b: typeof blocked) => (blocked = b),
    show: (s: string) => (shown = s),
    tick: (ms: number) => (clock += ms),
  }
}

test('a blocked session opens one approval with the dialog\'s choices and its own words', async () => {
  const { store, tracker, block } = setup()
  block({ kind: 'permission', msg: 'approve Bash: touch /tmp/c7lab/work/created-by-lab' })
  await tracker.check()
  await tracker.check()
  const [a] = store.openApprovals()
  expect(store.openApprovals()).toHaveLength(1)
  expect(a).toMatchObject({ topic: '42', kind: 'permission', prompt: 'approve Bash: touch /tmp/c7lab/work/created-by-lab', resolved: null })
  expect(a.choices.map(c => c.role)).toEqual(['approve', null, null, 'deny'])
})

test('a session that moves on without the app resolves its approval as expired, with no choice and no device', async () => {
  const { store, tracker, block, lines } = setup()
  block({ kind: 'permission', msg: 'approve Bash: ls' })
  await tracker.check()
  const [a] = store.openApprovals()
  block(undefined)
  await tracker.check()
  expect(store.openApprovals()).toEqual([])
  expect(store.approval(a.id)?.resolved).toEqual({ choice: null, by: null, at: expect.any(String) })
  expect(lines.some(l => l.includes('expired'))).toBeTrue()
})

test('blocked on a new dialog, the old approval expires and a new one opens', async () => {
  const { store, tracker, block } = setup()
  block({ kind: 'permission', msg: 'approve Bash: ls' })
  await tracker.check()
  const [first] = store.openApprovals()
  block({ kind: 'permission', msg: 'approve Bash: rm build' })
  await tracker.check()
  const [second] = store.openApprovals()
  expect(store.approval(first.id)?.resolved).not.toBeNull()
  expect(second.prompt).toBe('approve Bash: rm build')
})

test('a dialog not drawn yet waits a moment for its choices, then opens without them', async () => {
  const { store, tracker, block, show, tick } = setup()
  show('thinking…')
  block({ kind: 'question', msg: 'which branch?' })
  await tracker.check()
  expect(store.openApprovals()).toEqual([])
  tick(6_000)
  await tracker.check()
  expect(store.openApprovals()[0]).toMatchObject({ kind: 'question', choices: [] })
})
