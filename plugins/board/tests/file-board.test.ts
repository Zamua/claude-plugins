import { expect, test } from 'claude-code/testing'

import { CONFIG_FILE, engine, HOME, json, open, start, world } from './engine'

const NOW = Date.parse('2026-10-16T14:00:00Z')
const WORK_FILE = `${HOME}/boards/work.json`
const ONCALL_FILE = `${HOME}/boards/oncall.json`
const TICKET_PAGE = 'https://tickets.example.com/ticket/'
const TICKET_HISTORY = 'https://tickets.example.com/history/'

const CONFIG = {
  boards: [
    { id: 'work', path: '~/boards/work.json', layout: 'groups' },
    {
      id: 'oncall',
      path: '~/boards/oncall.json',
      layout: 'sections',
      stale_minutes: 12,
      stale_text: 'The monitor may be stuck.',
      titles: { done: 'Done today' },
    },
  ],
  link_labels: { 'dash.example.com': 'Dashboard' },
  link_pairs: [{ first: TICKET_PAGE, second: TICKET_HISTORY, label: 'history' }],
}

const WORK = {
  updated_at: '2026-10-16T13:55:00Z',
  groups: [
    {
      id: 'pay',
      title: 'Payments rework',
      source: 'https://linear.app/acme/project/payments',
      links: [{ label: 'SDD', url: 'https://www.notion.so/sdd' }],
    },
    { id: 'pay-gross', parent: 'pay', title: 'Gross' },
    { id: 'tooling', title: 'Tooling' },
  ],
  items: [
    {
      id: 'scope',
      ref: 1,
      group: 'pay',
      section: 'needs',
      title: 'Scope the split against main',
      source: 'https://linear.app/acme/issue/AC-808',
      links: [{ label: 'api#6266', url: 'https://github.com/acme/api/pull/6266' }, { url: 'https://acme.slack.com/archives/D1/p1' }],
    },
    { id: 'fee-account', ref: 22, group: 'pay-gross', section: 'waiting', title: 'Fee account' },
    { id: 'gross', ref: 2, group: 'pay-gross', section: 'flight', title: 'Gross funding', workspace: 'ac-809-gross', due: '2026-10-16T20:00:00Z', due_label: 'review' },
    { id: 'fee-done', ref: 12, group: 'pay-gross', section: 'done', title: 'Fee pull settled', links: [{ label: 'Slack thread', url: 'https://acme.slack.com/archives/C1/p1' }] },
    {
      id: 'adapter',
      ref: 7,
      group: 'pay',
      section: 'next',
      title: 'Purchase adapter',
      due: '2026-10-23T00:00:00Z',
      source: 'https://linear.app/acme/issue/AC-806',
      links: [{ url: 'https://linear.app/acme/issue/AC-806' }, { label: 'api#1', url: 'https://github.com/acme/api/pull/1' }, { label: 'again', url: 'https://github.com/acme/api/pull/1' }],
    },
    { id: 'alerts', ref: 8, group: 'pay', section: 'next', title: 'Alerts' },
    { id: 'okta', ref: 3, group: 'tooling', section: 'waiting', title: 'Okta app' },
    { id: 'refund-fee', ref: 10, section: 'next', title: 'Refund fee' },
    { id: 'gate', ref: 20, group: 'mystery', section: 'done', title: 'Registry gate' },
  ],
}

const ONCALL = {
  updated_at: '2026-10-16T13:58:00Z',
  items: [
    { id: 'triage', ref: 7, section: 'needs', title: 'Triage SER-1', due: '2026-10-17T00:35:00Z', due_label: 'SLA' },
    {
      id: 'reply',
      section: 'needs',
      title: 'Reply on the reserve thread',
      workspace: 'reserve-loans',
      source: 'https://acme.slack.com/archives/C2/p2',
      links: [
        { label: 'Ticket 1499', url: `${TICKET_PAGE}1499` },
        { label: 'Ticket 1499 history', url: `${TICKET_HISTORY}1499` },
        { url: 'https://dash.example.com/q/24176' },
      ],
    },
    { id: 'deploy', section: 'flight', title: '#7284 to prod', due: '2026-10-17T09:00:00Z' },
    { id: 'dlq', section: 'watching', title: 'Audit DLQ 117' },
    { id: 'dbt', section: 'done', title: 'dbt fix live' },
  ],
}

const herdr = (argv: readonly string[]) =>
  argv[0] === 'herdr' && argv[2] === 'list'
    ? {
        exitCode: 0,
        stdout: json({ result: { workspaces: [{ label: 'ac-809-gross', workspace_id: 'w3' }, { label: 'reserve-loans', workspace_id: 'w8' }] } }),
        stderr: '',
      }
    : undefined

const boards = (over: Record<string, string> = {}) =>
  world({ files: { [CONFIG_FILE]: json(CONFIG), [WORK_FILE]: json(WORK), [ONCALL_FILE]: json(ONCALL), ...over }, run: herdr })

test('items draw inside their project box, nested by workstream, whatever their status', async ($, on) => {
  engine(on, boards(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'group-pay' })).toMatchObject({ props: { borderStyle: 'round' } })
  expect(await ui.find({ key: 'group-pay', text: /Scope the split against main/ })).toBeDefined()
  expect(await ui.find({ key: 'group-pay', text: /Purchase adapter/ })).toBeDefined()
  expect(await ui.find({ key: 'group-pay-gross', text: /Fee account/ })).toBeDefined()
  expect(await ui.find({ key: 'group-pay-gross', text: /Gross funding/ })).toBeDefined()
  expect(await ui.find({ key: 'group-pay-gross', text: /Purchase adapter/ })).toBeUndefined()
  expect(await ui.find({ key: 'group-tooling', text: /Okta app/ })).toBeDefined()
  expect(await ui.find({ key: 'body-pay', text: /Gross/ })).toMatchObject({ props: { paddingLeft: 2 } })
  expect(await ui.find({ key: 'heading-pay', text: /Payments rework\s*5/ })).toBeDefined()
  expect(await ui.find({ key: 'heading-pay-gross', text: /Gross\s*2/ })).toBeDefined()
  await ui.unmount()
})

test('each work item carries its status as a colored tag, sorted by status inside its group', async ($, on) => {
  engine(on, boards(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'head-scope', text: /^you\s+#1 Scope/ })).toBeDefined()
  expect(await ui.find({ key: 'head-gross', text: /^now\s+#2 Gross/ })).toBeDefined()
  const colors = (await ui.findAll({ type: 'Text', text: /^(you|now|wait)\s*$/ })).map(el => [el.text.trim(), el.props.color])
  expect(colors).toContainEqual(['you', 'warning'])
  expect(colors).toContainEqual(['now', 'success'])
  expect(colors).toContainEqual(['wait', 'permission'])
  expect(await ui.find({ type: 'Text', text: '#12 Fee pull settled' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: 'review in 6h' })).toMatchObject({ props: { color: 'yellow' } })
  expect(await ui.find({ type: 'Text', text: 'Fri 10-23' })).toBeDefined()
  const titles = (await ui.findAll({ text: /^#(2|7|12|20|22) / })).map(el => el.text.split(' ')[0])
  expect(titles).toEqual(['#7', '#2', '#22', '#12', '#20'])
  await ui.unmount()
})

test('finished work items show their title alone, and items in no known group land in Other', async ($, on) => {
  engine(on, boards(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'link-fee-done-0' })).toBeUndefined()
  expect(await ui.find({ key: 'group-other', text: /Refund fee/ })).toBeDefined()
  expect(await ui.find({ key: 'group-other', text: /Registry gate/ })).toBeDefined()
  await ui.unmount()
})

test('the work summary counts each status and lists up next in take order across groups', async ($, on) => {
  engine(on, boards(), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ type: 'Text', text: 'you 1' })).toMatchObject({ props: { color: 'warning' } })
  expect(await ui.find({ key: 'counts', text: /next 3/ })).toBeDefined()
  expect(await ui.find({ key: 'counts', text: /wait 2/ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Up next: #7, #8, #10$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Updated 5m ago\. A title opens/ })).toBeDefined()
  await ui.unmount()
})

test('links are labelled by site, drawn once each, and open in the browser', async ($, on) => {
  const w = boards()
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'glink-pay-0' })).toMatchObject({ props: { label: 'Linear' } })
  expect(await ui.find({ key: 'glink-pay-1' })).toMatchObject({ props: { label: 'SDD' } })
  expect(await ui.find({ key: 'src-scope' })).toMatchObject({ props: { label: 'Linear' } })
  expect(await ui.find({ key: 'link-scope-1' })).toMatchObject({ props: { label: 'Slack' } })
  expect(await ui.find({ key: 'link-adapter-0' })).toBeUndefined()
  expect(await ui.find({ key: 'link-adapter-1' })).toMatchObject({ props: { label: 'api#1' } })
  expect(await ui.find({ key: 'link-adapter-2' })).toBeUndefined()
  await ui.press({ key: 'link-scope-0' })
  expect(w.runs).toContainEqual(['open', 'https://github.com/acme/api/pull/6266'])
  await ui.unmount()
})

test('pressing a title opens its herdr workspace, and a title without one is plain text', async ($, on) => {
  const w = boards()
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'title-scope' })).toBeUndefined()
  expect(await ui.find({ key: 'title-gross' })).toMatchObject({ props: { label: '#2 Gross funding' } })
  await ui.press({ key: 'title-gross' })
  expect(w.runs).toContainEqual(['herdr', 'workspace', 'focus', 'w3'])
  await ui.unmount()
})

test('a sections board draws one colored box per status, needs first and done dimmed last', async ($, on) => {
  engine(on, boards(), NOW)
  await start($)

  const ui = await open($, 'oncall')
  expect(await ui.find({ key: 'section-needs' })).toMatchObject({ props: { borderStyle: 'round', borderColor: 'warning' } })
  expect(await ui.find({ key: 'section-flight' })).toMatchObject({ props: { borderColor: 'success' } })
  expect(await ui.find({ key: 'section-watching' })).toMatchObject({ props: { borderColor: 'suggestion' } })
  expect(await ui.find({ key: 'section-done' })).toMatchObject({ props: { borderColor: 'inactive', borderDimColor: true } })
  expect(await ui.find({ key: 'heading-needs', text: /Needs you\s*2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Done today' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'dbt fix live' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: 'SLA in 11h' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'in 19h' })).toBeDefined()
  await ui.unmount()
})

test('an empty Needs you still draws and says nothing needs you', async ($, on) => {
  const calm = { ...ONCALL, items: ONCALL.items.filter(item => item.section !== 'needs') }
  engine(on, boards({ [ONCALL_FILE]: json(calm) }), NOW)
  await start($)

  const ui = await open($, 'oncall')
  expect(await ui.find({ key: 'section-needs', text: /^Nothing needs you/ })).toBeDefined()
  await ui.unmount()
})

test('a link followed by its paired page for the same id shares one line with it', async ($, on) => {
  const w = boards()
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'oncall')
  expect(await ui.find({ key: 'src-reply' })).toMatchObject({ props: { label: 'Slack' } })
  expect(await ui.find({ key: 'link-reply-0' })).toMatchObject({ props: { label: 'Ticket 1499' } })
  expect(await ui.find({ key: 'line-link-reply-0', text: /Ticket 1499\s*history$/ })).toBeDefined()
  expect(await ui.find({ key: 'line-link-reply-1' })).toBeUndefined()
  expect(await ui.find({ key: 'link-reply-2' })).toMatchObject({ props: { label: 'Dashboard' } })
  await ui.press({ key: 'link-reply-1' })
  expect(w.runs).toContainEqual(['open', `${TICKET_HISTORY}1499`])
  await ui.press({ key: 'title-reply' })
  expect(w.runs).toContainEqual(['herdr', 'workspace', 'focus', 'w8'])
  await ui.unmount()
})

test('a board older than its stale limit says its writer may be stuck', async ($, on) => {
  engine(on, boards(), NOW + 20 * 60_000)
  await start($)

  const ui = await open($, 'oncall')
  expect(await ui.find({ type: 'Text', text: 'Not updated for 22m. The monitor may be stuck.' })).toMatchObject({ props: { color: 'red' } })
  await ui.unmount()
})

test('a board whose file is missing is left off the switcher, and opened by name says where it is expected', async ($, on) => {
  const w = boards()
  delete w.files[WORK_FILE]
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'oncall')
  expect(await ui.find({ key: 'tab-work' })).toBeUndefined()
  await ui.unmount()
  const named = await open($, 'work')
  expect(await named.find({ type: 'Text', text: `No board yet at ${WORK_FILE}` })).toBeDefined()
  expect(await named.find({ key: 'tab-work' })).toBeDefined()
  await named.unmount()
})
