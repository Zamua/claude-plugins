import { expect, test } from 'claude-code/testing'

import { CONFIG_FILE, engine, HOME, open, start } from './engine'
import { herdrHost, sessionBoard, sessionRecord, storeFile, TREE, withLive, withTree } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'
const WORK_FILE = `${HOME}/work.json`

type File = { items: { id: string; parent?: string; ref?: number; status?: string }[]; links: { child: string; parent: string }[] }
const fileOf = (files: Record<string, string>) => JSON.parse(files[WORK_FILE] ?? '{}') as File

test('a read lists every Item with its id, kind, rolled-up status and needs count', async ($, on) => {
  engine(on, withTree(), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toContain('file:pay [Project, needs, 1 need you] Payments rework')
  expect(read).toContain('    file:fee #3 [Task, needs] Settle the fee account')
  expect(read).toMatch(/Responsibilities:\nfile:tooling \[Responsibility, next\] Tooling/)
})

test('added Items get the next ref and appear under their parent', async ($, on) => {
  const w = withTree()
  engine(on, w, NOW)
  await start($)

  const added = await $.tool.call({ tool: TOOL, add: [{ title: 'Write the doc', kind: 'Task', parent: 'pay', status: 'next' }] })
  expect(added.result).toBe('Work updated. Added file:write-the-doc (#10).')
  expect(fileOf(w.files).items.find(i => i.id === 'write-the-doc')).toMatchObject({ parent: 'pay', ref: 10, status: 'next' })

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wrow-file:write-the-doc', text: /next\s*#10\s*Write the doc/ })).toBeDefined()
  await ui.unmount()
})

test('an update moves an Item, and a link sets a hand parent until it is unlinked', async ($, on) => {
  const w = withTree()
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, update: [{ id: 'fee', parent: 'pay', status: 'flight' }] })
  expect(fileOf(w.files).items.find(i => i.id === 'fee')).toMatchObject({ parent: 'pay', status: 'flight' })

  await $.tool.call({ tool: TOOL, link: [{ child: 'hostit', parent: 'pay' }] })
  expect(fileOf(w.files).links).toEqual([{ child: 'file:hostit', parent: 'file:pay', at: '2026-10-27T14:00:00.000Z' }])
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('  file:hostit #6 [Project, next] hostit site list')

  await $.tool.call({ tool: TOOL, unlink: ['hostit'] })
  expect(fileOf(w.files).links).toEqual([])
})

test('a change that names an unknown Item, edits another source, loops, or orphans children is refused whole', async ($, on) => {
  const w = withTree()
  engine(on, w, NOW)
  await start($)
  const before = w.files[WORK_FILE]

  const unknown = await $.tool.call({ tool: TOOL, add: [{ title: 'Kept out', kind: 'Task' }], update: [{ id: 'nope', status: 'done' }] })
  expect(unknown.deny).toContain('No Item nope')
  const foreign = await $.tool.call({ tool: TOOL, update: [{ id: 'linear:MM-1', status: 'done' }] })
  expect(foreign.deny).toContain('belongs to another source')
  const loop = await $.tool.call({ tool: TOOL, update: [{ id: 'pay', parent: 'fee' }] })
  expect(loop.deny).toContain('its own ancestor')
  const orphans = await $.tool.call({ tool: TOOL, remove: ['gross'] })
  expect(orphans.deny).toContain('still has children')
  const status = await $.tool.call({ tool: TOOL, update: [{ id: 'fee', status: 'later' }] })
  expect(status.deny).toContain('No status later')
  expect(w.files[WORK_FILE]).toBe(before)

  await $.tool.call({ tool: TOOL, remove: ['scope'] })
  expect(fileOf(w.files).items.map(i => i.id)).not.toContain('scope')
  expect(fileOf(w.files).items).toHaveLength(TREE.items.length - 1)
})

// The session the tests run as, `s1`, sits in the herdr pane w4:p1
const SELF = { id: 'w4:p1', label: 'coordinator', harnessId: 's1' }
const SELF_ID = 'session:herdr:default/w4:p1'
const NEW_ID = 'session:herdr:default/w9:p1'

test('start opens a session for an Item through herdr, briefed and linked under it with this session coordinating', async ($, on) => {
  const created = { id: 'w9:p1', label: 'scope-the-split', harnessId: 'h-new' }
  const w = withLive(TREE, herdrHost([SELF], created), sessionRecord(9, 'h-new', 'zamua-9', NOW))
  engine(on, w, NOW)
  await start($)

  const started = await $.tool.call({ tool: TOOL, start: [{ item: 'scope', brief: 'Split the scope doc in two.' }] })
  expect(started.result).toBe(`Work updated. Started ${NEW_ID} (scope-the-split, message zamua-9) for file:scope.`)
  expect(w.runs).toContainEqual([
    'herdr', '--session', 'default', 'workspace', 'create', '--cwd', HOME, '--label', 'scope-the-split', '--no-focus', '--env', 'BOARD_WORK_ITEM=file:scope',
  ])
  expect(w.runs).toContainEqual([
    'herdr', '--session', 'default', 'agent', 'start', 'scope-the-split', '--kind', 'claude', '--pane', 'w9:p1', '--timeout', '60000', '--', '--model', 'opus',
  ])
  expect(w.runs).toContainEqual(['herdr', '--session', 'default', 'agent', 'prompt', 'scope-the-split', 'Split the scope doc in two.'])
  expect(fileOf(w.files).links).toEqual([
    { child: NEW_ID, parent: 'file:scope', at: '2026-10-27T14:00:00.000Z' },
    { child: NEW_ID, parent: SELF_ID, at: '2026-10-27T14:00:00.000Z' },
  ])

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  expect(await ui.find({ key: 'wmark-file:scope' })).toBeDefined()
  await ui.unmount()
})

test('a session started from one on another board config runs on that config too', async ($, on) => {
  const created = { id: 'w9:p1', label: 'scope-the-split', harnessId: 'h-new' }
  const w = withLive(TREE, herdrHost([SELF], created), sessionRecord(9, 'h-new', 'zamua-9', NOW))
  w.env = { ...w.env, BOARD_CONFIG: CONFIG_FILE }
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, start: [{ item: 'scope', brief: 'Split the scope doc in two.' }] })
  const create = w.runs.find(argv => argv.includes('create')) ?? []
  expect(create).toContain(`BOARD_CONFIG=${CONFIG_FILE}`)
  expect(create).toContain('BOARD_WORK_ITEM=file:scope')
})

test('a second start for an Item with a running session is refused, naming it, unless asked again', async ($, on) => {
  const running = { id: 'w9:p1', label: 'scope-the-split', harnessId: 'h-new' }
  const links = [{ child: NEW_ID, parent: 'file:scope', at: '2026-10-27T13:00:00Z' }]
  const again = { id: 'w10:p1', label: 'scope-the-split-2', harnessId: 'h-again' }
  const w = withLive({ ...TREE, links }, herdrHost([SELF, running], again), sessionRecord(9, 'h-new', 'zamua-9', NOW))
  engine(on, w, NOW)
  await start($)
  const before = w.files[WORK_FILE]

  const refused = await $.tool.call({ tool: TOOL, start: [{ item: 'scope', brief: 'Again.' }] })
  expect(refused.deny).toBe('file:scope already has a running session, scope-the-split, message zamua-9. Message it instead, or pass again: true to start another.')
  expect(w.files[WORK_FILE]).toBe(before)
  expect(w.runs.some(argv => argv.includes('create'))).toBe(false)

  const second = await $.tool.call({ tool: TOOL, start: [{ item: 'scope', brief: 'Again.', again: true }] })
  expect(second.result).toContain('Started session:herdr:default/w10:p1 (scope-the-split-2) for file:scope.')
})

test('a read gives each session its state, message name, and the goal and summary from its session board', async ($, on) => {
  const links = [{ child: SELF_ID, parent: 'file:hostit', at: '2026-10-27T13:00:00Z' }]
  const files = {
    ...sessionRecord(4, 's1', 'zamua-4', NOW),
    ...storeFile(sessionBoard('s1', 'Keep hostit healthy', 'Site list drafted\nWaiting on Hasan')),
  }
  engine(on, withLive({ ...TREE, links }, herdrHost([SELF]), files), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toContain(
    [
      '  file:hostit #6 [Project, next] hostit site list',
      `    ${SELF_ID} [idle] coordinator, message zamua-4`,
      '      goal: Keep hostit healthy',
      '      summary: Site list drafted Waiting on Hasan',
    ].join('\n'),
  )
})

test('attach puts this session under an Item, keeping the Coordinator it already has', async ($, on) => {
  const links = [{ child: SELF_ID, parent: 'session:herdr:default/w1:p1', at: '2026-10-27T13:00:00Z' }]
  const w = withLive({ ...TREE, links }, herdrHost([SELF, { id: 'w1:p1', label: 'root', harnessId: 'h-root' }]))
  engine(on, w, NOW)
  await start($)

  expect((await $.tool.call({ tool: TOOL, attach: 'hostit' })).result).toBe('Work updated.')
  expect(fileOf(w.files).links).toEqual([
    { child: SELF_ID, parent: 'session:herdr:default/w1:p1', at: '2026-10-27T13:00:00Z' },
    { child: SELF_ID, parent: 'file:hostit', at: '2026-10-27T14:00:00.000Z' },
  ])
  const unknown = await $.tool.call({ tool: TOOL, link: [{ child: 'hostit', parent: SELF_ID }] })
  expect(unknown.deny).toBe(`Only a session can sit under the session ${SELF_ID}.`)
})
