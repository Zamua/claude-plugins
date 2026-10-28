import { expect, test } from 'claude-code/testing'

import { CONFIG_FILE, engine, HOME, json, open, start, world } from './engine'
import { herdrHost, LIVE_CONFIG, TREE, WORK_FILE } from './work-fixtures'
import type { HerdrPane } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'
const SELF: HerdrPane = { id: 'w4:p1', label: 'coordinator', harnessId: 's1' }
const ENV = ['--env', 'BOARD_WORK_ITEM=file:scope']

const withAreas = (file: unknown, panes: HerdrPane[], created?: HerdrPane) => {
  const spec = { ...LIVE_CONFIG.boards[0], hosts: { herdr: { workspaces: { 'file:pay': 'payments' } } } }

  return world({ files: { [CONFIG_FILE]: json({ boards: [spec] }), [WORK_FILE]: json(file) }, run: herdrHost(panes, created) })
}

test('a session started for an Item under a branch that names a workspace opens as a tab there, named for the Item', async ($, on) => {
  const planning: HerdrPane = { id: 'w2:p1', label: 'payments', harnessId: 'h-plan', tab: { id: 'w2:t1', label: 'plan-the-split' } }
  const created: HerdrPane = { id: 'w2:p2', label: 'payments', harnessId: 'h-new', tab: { id: 'w2:t2', label: 'scope-the-split' } }
  const w = withAreas(TREE, [SELF, planning], created)
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, start: [{ item: 'scope', brief: 'Split the scope doc in two.' }] })
  expect(w.runs).toContainEqual([
    'herdr', '--session', 'default', 'tab', 'create', '--workspace', 'w2', '--cwd', HOME, '--label', 'scope-the-split', '--no-focus', ...ENV,
  ])
  expect(w.runs.some(argv => argv.includes('workspace') && argv.includes('create'))).toBe(false)
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain(
    '  file:scope #4 [Task, flight] Scope the split\n    session:herdr:default/w2:p2 [idle] scope-the-split',
  )
})

test('the first session of such a branch makes its workspace, named for the branch, and names its tab for the Item', async ($, on) => {
  const created: HerdrPane = { id: 'w9:p1', label: 'payments', harnessId: 'h-new' }
  const w = withAreas(TREE, [SELF], created)
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, start: [{ item: 'scope', brief: 'Split the scope doc in two.' }] })
  expect(w.runs).toContainEqual(['herdr', '--session', 'default', 'workspace', 'create', '--cwd', HOME, '--label', 'payments', '--no-focus', ...ENV])
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('    session:herdr:default/w9:p1 [idle] scope-the-split')
})

test('an Item outside every named branch still starts its session in a workspace of its own', async ($, on) => {
  const created: HerdrPane = { id: 'w9:p1', label: 'hostit-site-list', harnessId: 'h-new' }
  const w = withAreas(TREE, [SELF], created)
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: TOOL, start: [{ item: 'hostit', brief: 'List the sites.' }] })
  expect(w.runs.find(argv => argv.includes('create'))).toEqual([
    'herdr', '--session', 'default', 'workspace', 'create', '--cwd', HOME, '--label', 'hostit-site-list', '--no-focus', '--env', 'BOARD_WORK_ITEM=file:hostit',
  ])
})

test('pressing a session brings its workspace and then its tab to the front', async ($, on) => {
  const scoping: HerdrPane = { id: 'w2:p2', label: 'payments', status: 'blocked', harnessId: 'h-scope', tab: { id: 'w2:t2', label: 'scope-the-split' } }
  const links = [{ child: 'session:herdr:default/w2:p2', parent: 'file:scope', at: '2026-10-27T13:00:00Z' }]
  const w = withAreas({ ...TREE, links }, [SELF, scoping])
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'work')
  await ui.press({ key: 'wtoggle-file:pay' })
  await ui.press({ key: 'wmark-file:scope' })
  const focused = w.runs.filter(argv => argv.includes('focus'))
  expect(focused).toEqual([
    ['herdr', '--session', 'default', 'workspace', 'focus', 'w2'],
    ['herdr', '--session', 'default', 'tab', 'focus', 'w2:t2'],
  ])
  await ui.unmount()
})
