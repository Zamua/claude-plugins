import { expect, test } from 'claude-code/testing'

import { CONFIG_FILE, engine, HOME, json, open, start, world } from './engine'
import { TREE, WORK_FILE } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'

const LINEAR = { team: 'MM', projects: [{ name: 'CRB Funding', under: 'file:pay' }], kinds: { issue: 'Issue' } }
const config = (sources: Record<string, unknown>) => ({ boards: [{ id: 'work', layout: 'model', path: '~/work.json', sources }] })
// `fee` already stands for MM-9 on the board, so Linear's MM-9 is drawn as `fee`
const LOCAL = { ...TREE, items: TREE.items.map(item => (item.id === 'fee' ? { ...item, aliases: ['MM-9'] } : item)) }

const issue = (identifier: string, title: string, state: { name: string; type: string }, more: Record<string, unknown> = {}) => ({
  identifier,
  title,
  state,
  url: `https://linear.app/t/issue/${identifier}`,
  assignee: { name: 'Mert Kutay' },
  parent: null,
  ...more,
})
const ISSUES = [
  issue('MM-1', 'Add the purchase adapter', { name: 'In Progress', type: 'started' }),
  issue('MM-2', 'Add the reserve client', { name: 'In Review', type: 'started' }),
  issue('MM-3', 'Ship the fee route', { name: 'Done', type: 'completed' }),
  issue('MM-4', 'Write the runbook', { name: 'Backlog', type: 'backlog' }),
  issue('MM-5', 'Test the adapter', { name: 'Todo', type: 'unstarted' }, { parent: { identifier: 'MM-1' } }),
  issue('MM-9', 'Settle the fee account', { name: 'In Progress', type: 'started' }),
  issue('MM-10', 'Find the fee account id', { name: 'Todo', type: 'unstarted' }, { parent: { identifier: 'MM-9' } }),
]

function linearWorld() {
  const w = world({ files: { [CONFIG_FILE]: json(config({ linear: LINEAR })), [WORK_FILE]: json(LOCAL) } })
  let answer = { exitCode: 0, stdout: json(ISSUES), stderr: '' }
  w.run = argv => (argv[0] === 'linear' ? answer : undefined)

  return { w, fail: (stderr: string) => (answer = { exitCode: 1, stdout: '', stderr }) }
}
const linearRuns = (runs: string[][]) => runs.filter(argv => argv[0] === 'linear').length

test("a followed Linear project sits under its configured Item, with its issues by Linear's states", async ($, on) => {
  const { w } = linearWorld()
  engine(on, w, NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/file:pay [^\n]*\n(.*\n)*\s+linear:project:crb-funding \[Project, flight\] CRB Funding/)
  expect(read).toContain('linear:MM-1 [Issue, flight] Add the purchase adapter')
  expect(read).toMatch(/linear:MM-1 \[Issue, flight\] Add the purchase adapter\n\s+linear:MM-5 \[Issue, next\] Test the adapter/)
  expect(read).toContain('linear:MM-2 [Issue, waiting] Add the reserve client')
  expect(read).toContain('linear:MM-3 [Issue, done] Ship the fee route')
  expect(read).toContain('linear:MM-4 [Issue, next] Write the runbook')
  expect(read).not.toContain('linear:MM-9 ')
  expect(read).toMatch(/file:fee #3 \[Task, needs\] Settle the fee account\n\s+linear:MM-10 \[Issue, next\] Find the fee account id/)
  expect(w.runs.find(argv => argv[0] === 'linear')).toEqual([
    'linear', 'issue', 'list', '--team', 'MM', '--project', 'CRB Funding', '--all-states', '--all-assignees', '--limit', 'all', '--json', '--no-input',
  ])
})

test('Linear is asked once per freshness window, and a failure keeps the last issues and says so', async ($, on) => {
  const { w, fail } = linearWorld()
  const clock = engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL })
  const asked = linearRuns(w.runs)

  w.session.id = 's2'
  await $.tool.call({ tool: TOOL })
  expect(linearRuns(w.runs)).toBe(asked)

  fail('Authentication expired')
  await clock.advance(11 * 60_000)
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('linear:MM-1 [Issue, flight]')
  const ui = await open($, 'work')
  expect(await ui.find({ type: 'Text', text: 'Linear: Authentication expired' })).toBeDefined()
  await ui.unmount()
})

const OBJ = { uuid: '00000000-0000-0000-0000-00000000000a', short_id: 'OBJ-1', title: 'Parity with Lead', type: 'Okrs::Objective', current_status: 'on_track', progress: 95, owner_names: ['Alex Shugaley'], latest_checkin: { note: 'Code complete this week.', checkin_date: '2026-10-26' } }
const KR = (short: string, title: string, status: string, progress: number | null) => ({
  uuid: `00000000-0000-0000-0000-0000000000${short.slice(-2)}`,
  short_id: short,
  title,
  type: 'Okrs::KeyResult',
  current_status: status,
  progress,
  parent_uuids: [OBJ.uuid],
})

function rhythmsWorld() {
  const sources = { rhythms: { follow: ['OBJ-1'], kinds: { key_result: 'KR' } } }
  return world({
    files: { [CONFIG_FILE]: json(config(sources)), [WORK_FILE]: json(TREE) },
    mcp: {
      mcp__rhythms__get_goal: () => ({ data: { record: { uuid: OBJ.uuid } } }),
      mcp__rhythms__search_knowledge: () => ({
        data: { records: [OBJ], children: [KR('KR-61', 'Instant funding', 'on_track', 100), KR('KR-57', '100 loans through CRB', 'not_started', null)] },
      }),
    },
  })
}

test('a followed goal and its key results come from Rhythms, with progress and the configured Kind names', async ($, on) => {
  const w = rhythmsWorld()
  engine(on, w, NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/rhythms:OBJ-1 \[Objective, flight\] Parity with Lead\n\s+rhythms:KR-61 \[KR, flight\] Instant funding/)
  expect(read).toContain('rhythms:KR-57 [KR, next] 100 loans through CRB')
  const search = w.toolCalls.find(call => call.tool === 'mcp__rhythms__search_knowledge')
  expect(search?.input).toMatchObject({ type: 'goal', goal_uuids: [OBJ.uuid], include_children: true })

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'wtoggle-rhythms:OBJ-1', text: /Objective 95% Parity with Lead/ })).toBeDefined()
  await ui.press({ key: 'wtoggle-rhythms:OBJ-1' })
  expect(await ui.find({ type: 'Markdown', text: /Code complete this week/ })).toBeDefined()
  expect(await ui.find({ key: 'wrow-rhythms:KR-61', text: /now\s+100% Instant funding/ })).toBeDefined()
  await ui.unmount()
})

test('Rhythms is asked from reads and the view opening, never from the timer', async ($, on) => {
  const w = rhythmsWorld()
  const clock = engine(on, w, NOW)
  await start($)
  const ui = await open($, 'work')
  const asked = w.toolCalls.length
  expect(asked).toBeGreaterThan(0)

  await clock.advance(61 * 60_000)
  expect(w.toolCalls.length).toBe(asked)
  await ui.unmount()
  await $.turn.start({ text: 'how are the goals?', turnId: 't1' })
  await $.tool.call({ tool: TOOL })
  expect(w.toolCalls.length).toBeGreaterThan(asked)
})

test('a local Item can be linked under a goal another Source holds', async ($, on) => {
  const w = rhythmsWorld()
  engine(on, w, NOW)
  await start($)

  expect((await $.tool.call({ tool: TOOL, link: [{ child: 'pay', parent: 'rhythms:OBJ-1' }] })).result).toBe('Work updated.')
  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/rhythms:OBJ-1 [^\n]*\n(.*\n)*\s+file:pay \[Project/)
  expect(JSON.parse(w.files[`${HOME}/work.json`] ?? '{}').links).toEqual([{ child: 'file:pay', parent: 'rhythms:OBJ-1', at: '2026-10-27T14:00:00.000Z' }])
})

test("another board's items sit under the local Item named for it, its archive left out", async ($, on) => {
  const boards = {
    boards: [
      { id: 'work', layout: 'model', path: '~/work.json', sources: { boards: { oncall: 'tooling' } } },
      { id: 'oncall', layout: 'sections', path: '~/oncall.json' },
    ],
  }
  const oncall = {
    items: [
      { id: 'mm-982', section: 'watching', title: 'Watch MM-982 to 10-29', workspace: 'oncall-monitor', source: 'https://slack.com/x', source_label: 'Slack' },
      { id: 'dp-sweep', section: 'done', title: 'Double DP sweep' },
      { id: 'old', section: 'archive', title: 'An old shift item' },
    ],
  }
  engine(on, world({ files: { [CONFIG_FILE]: json(boards), [WORK_FILE]: json(TREE), [`${HOME}/oncall.json`]: json(oncall) } }), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/file:tooling \[Responsibility, next\] Tooling\n(.*\n)*\s+board:oncall:mm-982 \[Task, watching\] Watch MM-982 to 10-29/)
  expect(read).toContain('board:oncall:dp-sweep [Task, done] Double DP sweep')
  expect(read).not.toContain('An old shift item')
})
