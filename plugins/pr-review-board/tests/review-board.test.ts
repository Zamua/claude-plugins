import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-21T14:00:00Z')
const HOME = '/home/test'
const SESSION = 'sess-mine'
const STATE_FILE = HOME + '/.config/pr-review-board/state.json'
const BOARD_FILE = HOME + '/workspace/reviews/.pr-review-board/stack-7472/board.json'
const MANUAL_FILE = HOME + '/workspace/reviews/.pr-review-board/manual-sess-hand/board.json'

const STATE = {
  reviews: {
    'other-1': { status: 'ACTIVE', slug: 'other-1', claude_session: 'sess-other', prs: ['acme/api#1'] },
    'stack-7472': { status: 'ACTIVE', slug: 'lead-stack-6936', claude_session: SESSION, herdr_workspace: 'wT', prs: ['acme/api#6954', 'acme/api#7472'] },
    'old-9': { status: 'CLEANEDUP', slug: 'old-9', claude_session: SESSION, prs: ['acme/api#9'] },
  },
}

const BOARD = {
  schema: 2,
  updated_at: '2026-10-21T13:50:00Z',
  title: 'Lead adapters stack',
  verdict: 'medium',
  risk: 'Medium: money movement behind a gate at 0%.',
  blast_radius: 'From merge, a payment outage stops legacy Lead work.',
  prs: [
    { pr: 'acme/api#6954', number: 6954, title: 'Servicing steps aside', url: 'https://github.com/acme/api/pull/6954', risk: 'medium' },
    { pr: 'acme/api#7472', number: 7472, title: 'Bank fix', url: 'https://github.com/acme/api/pull/7472', risk: 'medium' },
  ],
  report: [
    { id: 'about', title: 'What this change is about', markdown: 'Moves Lead disbursement into **payment**.' },
    { id: 'risk', title: 'Risk and blast radius', markdown: 'Medium.' },
  ],
  comments: [
    {
      n: 6, pr: 'acme/api#6954', severity: 'live', confidence: 'proven', status: 'proposed', origin: 'new',
      summary: 'A payment outage stops legacy Lead work.', body: 'With the gate off, a 503 stops servicing.',
      detail: 'Every legacy handler asks payment first.', origin_note: 'Servicing never called payment.',
      target: 'DebtFacilityConfig.kt:227', location_url: 'https://github.com/acme/api/blob/a/x.kt#L227',
      files: [
        { label: 'PartnerPathOwnership.kt:37-41', url: 'https://github.com/acme/api/blob/a/o.kt#L37-L41' },
        { label: 'DebtFacilityConfig.kt:227', url: 'https://github.com/acme/api/blob/a/x.kt#L227' },
        { label: 'ReviewOutageScratchTest', url: 'file:///reviews/stack/api-6954/ReviewOutageScratchTest.kt', kind: 'test' },
      ],
    },
    { n: 1, pr: 'acme/api#7472', severity: 'medium', confidence: 'proven', status: 'proposed', origin: 'carried', summary: 'The sweep opens a fresh replacement.', body: 'An unanswered replacement.' },
    { n: 3, pr: 'acme/api#7472', severity: 'low', confidence: 'proven', status: 'posted', summary: 'Loan asks payment to replace legacy funds.', body: 'x', posted_url: 'https://github.com/acme/api/pull/7472#discussion_r1' },
    { n: 5, pr: 'acme/api#7472', severity: 'question', confidence: 'unproven', status: 'proposed', origin: 'none', summary: 'Is the description current?', body: 'Is it?' },
  ],
}

const PANE = {
  plugin: 'pr-review-board',
  component: 'Pane',
  requestId: 'review',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Review', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function stubs(on, { state = STATE as unknown, board = BOARD as unknown, manual = undefined as unknown, session = SESSION, fills = [] as unknown[], opens = [] as unknown[] } = {}) {
  mock.env(on, { HOME, HERDR_WORKSPACE_ID: 'wZ' })
  const files: Record<string, string> = {}
  if (state) files[STATE_FILE] = JSON.stringify(state)
  if (board) files[BOARD_FILE] = JSON.stringify(board)
  if (manual) files[MANUAL_FILE] = JSON.stringify(manual)
  on('session.id', () => ({ value: session }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: (files[e.path] || '').length, mtimeMs: 1, isLink: false } }))
  on('fs.read', ($, e) => ({ value: files[e.path] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.fill', ($, e) => {
    fills.push(e)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } }
  })
  on('session.start', () => ({ cwd: HOME }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
}

async function start($) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: HOME })
}

test('the board shows the live review this session recorded, not another session\'s or a cleaned-up one', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens: any[] = []
  stubs(on, { opens })
  await start($)

  expect(opens[0]).toMatchObject({ id: 'review', title: 'Review · Lead adapters stack' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'title-row', text: /Lead adapters stack\s*medium/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-6954' })).toBeDefined()
  expect(await ui.find({ key: 'prrow-1' })).toBeUndefined()
  await ui.unmount()
})

test('a review run by hand is found by the board its skill keys with this session\'s id', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens: any[] = []
  stubs(on, { state: { reviews: {} }, board: undefined, manual: { ...BOARD, title: 'By hand' }, session: 'sess-hand', opens })
  await start($)

  expect(opens[0]).toMatchObject({ id: 'review', title: 'Review · By hand' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'section-live', text: /A payment outage stops legacy Lead work/ })).toBeDefined()
  await ui.unmount()
})

test('comments sit in bordered sections by severity, live-on-merge first and questions last', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'section-live' })).toMatchObject({ props: { borderStyle: 'round', borderColor: 'error' } })
  expect(await ui.find({ key: 'section-live', text: /A payment outage stops legacy Lead work/ })).toBeDefined()
  expect(await ui.find({ key: 'section-medium', text: /The sweep opens a fresh replacement/ })).toBeDefined()
  expect(await ui.find({ key: 'section-question', text: /Is the description current/ })).toBeDefined()
  expect(await ui.find({ key: 'section-live', text: /Is the description current/ })).toBeUndefined()
  await ui.unmount()
})

test('a comment opens in place to show the exact text it posts, the finding, and where it comes from', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'body-md-6' })).toBeUndefined()
  await ui.press({ key: 'expand-6' })
  expect(await ui.find({ key: 'body-md-6' })).toMatchObject({ props: { text: 'With the gate off, a 503 stops servicing.' } })
  expect(await ui.find({ key: 'detail-md-6' })).toMatchObject({ props: { text: 'Every legacy handler asks payment first.' } })
  expect(await ui.find({ key: 'origin-md-6' })).toMatchObject({ props: { text: 'Servicing never called payment.' } })
  expect(await ui.find({ key: 'body-md-1' })).toBeUndefined()
  await ui.press({ key: 'expand-6' })
  expect(await ui.find({ key: 'body-md-6' })).toBeUndefined()
  await ui.unmount()
})

test('the report\'s sections stay closed until opened, below the comments to decide', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'report', text: /What this change is about\s*▸ Risk and blast radius/ })).toBeDefined()
  expect(await ui.find({ key: 'report-md-about' })).toBeUndefined()
  await ui.press({ key: 'report-about' })
  expect(await ui.find({ key: 'report-md-about' })).toMatchObject({ props: { text: 'Moves Lead disbursement into **payment**.' } })
  expect(await ui.find({ key: 'report-md-risk' })).toBeUndefined()
  const order = (await ui.findAll({ type: 'Box' })).map((b) => b.key)
  expect(order.indexOf('report')).toBeGreaterThan(order.indexOf('section-question'))
  expect(order.indexOf('report')).toBeLessThan(order.indexOf('section-posted'))
  await ui.unmount()
})

test('ticked comments draft the post command into the prompt box, and a posted one cannot be ticked', async ($, on) => {
  mock.clock(on, { now: NOW })
  const fills: any[] = []
  stubs(on, { fills })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'pick-3' })).toBeUndefined()
  await ui.press({ key: 'pick-6' })
  await ui.press({ key: 'pick-1' })
  await ui.press({ key: 'fill' })
  expect(fills).toEqual([expect.objectContaining({ text: 'post 1, 6' })])
  await ui.press({ key: 'pick-6' })
  await ui.press({ key: 'fill' })
  expect(fills[1]).toMatchObject({ text: 'post 1' })
  await ui.unmount()
})

test('the stack sits under the risk and blast lines, above the comments, and each comment links its PR again', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'summary', text: /Risk\s*Medium: money movement behind a gate at 0%\./ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Blast\s*From merge, a payment outage stops legacy Lead work\./ })).toBeDefined()
  const order = (await ui.findAll({ type: 'Box' })).map((b) => b.key)
  expect(order.indexOf('prs')).toBeGreaterThan(order.indexOf('summary'))
  expect(order.indexOf('prs')).toBeLessThan(order.indexOf('section-live'))
  const links = (await ui.findAll({ type: 'Link' })).map((l) => [l.props.label, l.props.href])
  expect(links.filter(([label, href]) => label === '#6954' && href === 'https://github.com/acme/api/pull/6954').length).toBe(2)
  expect(await ui.find({ key: 'head-6', text: /#6954/ })).toBeDefined()
  await ui.unmount()
})

test('each comment says whether it is a new bug, one carried over, or not a bug, and the summary counts them', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'head-6', text: /#6954\s*new/ })).toBeDefined()
  expect(await ui.find({ key: 'head-1', text: /#7472\s*carried over/ })).toBeDefined()
  expect(await ui.find({ key: 'head-5', text: /not a bug/ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /3 proven · 1 new · 1 carried over · 1 posted/ })).toBeDefined()
  await ui.unmount()
})

test('a posted comment moves out of its severity section into a Posted section below the rest', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'section-low' })).toBeUndefined()
  expect(await ui.find({ key: 'section-posted', text: /Posted\s*1\s*3\s*#7472\s*comment\s*Loan asks payment to replace legacy funds/ })).toBeDefined()
  expect(await ui.find({ key: 'section-posted', text: /payment outage/ })).toBeUndefined()
  const links = (await ui.findAll({ type: 'Link' })).map((l) => l.props.href)
  expect(links).toContain('https://github.com/acme/api/pull/7472#discussion_r1')
  await ui.unmount()
})

test('a comment links its anchor, the code it cites, and its scratch test, each file once', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ key: 'files-6' })
  expect(row?.text).toMatch(/DebtFacilityConfig\.kt:227\s*PartnerPathOwnership\.kt:37-41\s*test: ReviewOutageScratchTest/)
  const links = (await ui.findAll({ type: 'Link' })).map((l) => l.props.href)
  expect(links.filter((h) => h === 'https://github.com/acme/api/blob/a/x.kt#L227').length).toBe(1)
  expect(links).toContain('file:///reviews/stack/api-6954/ReviewOutageScratchTest.kt')
  await ui.unmount()
})

test('a session that runs no review opens no pane unasked and says so when opened', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens: any[] = []
  stubs(on, { session: 'sess-nobody', opens })
  await start($)

  expect(opens).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /runs no pr-review-board review/ })).toBeDefined()
  await ui.unmount()
})

const STACKED = {
  ...BOARD,
  prs: [
    { pr: 'acme/api#6954', number: 6954, title: 'Servicing steps aside', url: 'https://github.com/acme/api/pull/6954', risk: 'medium', author: 'ann' },
    { pr: 'acme/api#7472', number: 7472, title: 'Bank fix', url: 'https://github.com/acme/api/pull/7472', risk: 'medium', author: 'ann', base: 'acme/api#6954' },
    { pr: 'acme/api#7500', number: 7500, title: 'Side branch', url: 'https://github.com/acme/api/pull/7500', risk: 'low', author: 'bo', base: 'acme/api#6954' },
    { pr: 'acme/api#8000', number: 8000, title: 'Card target', url: 'https://github.com/acme/api/pull/8000', risk: 'low', author: 'bo' },
  ],
  stacks: [{ id: 'lead', title: 'Lead adapters', prs: ['acme/api#6954', 'acme/api#7472', 'acme/api#7500'] }],
  comments: [
    ...BOARD.comments,
    { n: 7, pr: 'acme/api#8000', severity: 'low', confidence: 'proven', status: 'proposed', summary: 'The card target is untested on the wire.', body: 'Untested.' },
  ],
}

test('each stack is a tab beside All, and a pull request in no stack is a stack of one', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, { board: STACKED })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tabs', text: /All\s*4.*Lead adapters\s*3.*#8000 Card target\s*1/ })).toBeDefined()
  const order = (await ui.findAll({ type: 'Box' })).map((b) => b.key)
  expect(order.indexOf('tabs')).toBeGreaterThan(order.indexOf('summary'))
  expect(order.indexOf('tabs')).toBeLessThan(order.indexOf('prs'))
  expect(await ui.find({ key: 'prrow-8000' })).toBeDefined()
  expect(await ui.find({ key: 'prrow-6954' })).toBeDefined()
  await ui.unmount()
})

test('a stack\'s tab shows only its pull requests and the comments on them, and All shows everything again', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, { board: STACKED })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-acme/api#8000' })
  expect(await ui.find({ key: 'prrow-8000' })).toBeDefined()
  expect(await ui.find({ key: 'prrow-6954' })).toBeUndefined()
  expect(await ui.find({ key: 'comment-7' })).toBeDefined()
  expect(await ui.find({ key: 'comment-6' })).toBeUndefined()
  expect(await ui.find({ key: 'section-posted' })).toBeUndefined()
  await ui.press({ key: 'tab-lead' })
  expect(await ui.find({ key: 'prs', text: /Lead adapters\s*3/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-8000' })).toBeUndefined()
  expect(await ui.find({ key: 'comment-6' })).toBeDefined()
  expect(await ui.find({ key: 'comment-7' })).toBeUndefined()
  expect(await ui.find({ key: 'section-posted', text: /Loan asks payment/ })).toBeDefined()
  await ui.press({ key: 'tab-all' })
  expect(await ui.find({ key: 'comment-6' })).toBeDefined()
  expect(await ui.find({ key: 'comment-7' })).toBeDefined()
  await ui.unmount()
})

test('a stack names its authors, and a layer that branches off a lower one says which', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, { board: STACKED })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'stack-lead', text: /Lead adapters\s*3\s*ann, bo/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-7500', text: /#7500.*bo.*on #6954.*Side branch/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-7472', text: /on #/ })).toBeUndefined()
  expect(await ui.find({ key: 'prrow-7472', text: /ann/ })).toBeDefined()
  await ui.unmount()
})

test('a board that names no stacks draws one list and no tabs', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tabs' })).toBeUndefined()
  expect(await ui.find({ key: 'prs', text: /Stack\s*2/ })).toBeDefined()
  await ui.unmount()
})
