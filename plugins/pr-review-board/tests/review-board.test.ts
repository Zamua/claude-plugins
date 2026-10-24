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

function stubs(on, { state = STATE as unknown, board = BOARD as unknown, manual = undefined as unknown, session = SESSION, fills = [] as unknown[], opens = [] as unknown[], panes = [] as unknown[], closes = [] as unknown[] } = {}) {
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
  on('ui.panes', () => ({ value: panes }))
  on('ui.close', ($, e) => {
    closes.push(e)
    return { value: undefined }
  })
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
  expect(order.indexOf('report')).toBeGreaterThan(order.indexOf('section-unaddressed'))
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
  expect(await ui.find({ key: 'summary', text: /4 comments · 3 proven · 1 new · 1 carried over/ })).toBeDefined()
  await ui.unmount()
})

test('a posted comment leaves its severity section for Unaddressed, and moves to Addressed once marked', async ($, on) => {
  mock.clock(on, { now: NOW })
  const marked = { ...BOARD, comments: [...BOARD.comments, { n: 8, pr: 'acme/api#6954', severity: 'medium', confidence: 'proven', status: 'posted', addressed: true, addressed_note: 'Fixed in abc1234.', summary: 'The retry drops the lock.', body: 'x', posted_url: 'https://github.com/acme/api/pull/6954#discussion_r8' }] }
  stubs(on, { board: marked })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'section-low' })).toBeUndefined()
  expect(await ui.find({ key: 'section-posted' })).toBeUndefined()
  expect(await ui.find({ key: 'section-unaddressed', text: /Unaddressed\s*1\s*3\s*#7472\s*comment\s*Loan asks payment to replace legacy funds/ })).toBeDefined()
  expect(await ui.find({ key: 'section-unaddressed', text: /retry drops the lock/ })).toBeUndefined()
  expect(await ui.find({ key: 'section-addressed', text: /Addressed\s*1\s*8\s*#6954\s*comment\s*The retry drops the lock\.\s*Fixed in abc1234\./ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /3 to decide · 1 unaddressed · 1 addressed/ })).toBeDefined()
  expect(await ui.find({ key: 'title-row', text: /Lead adapters stack\s*medium\s*open items/ })).toBeDefined()
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
  stacks: [
    {
      id: 'lead', title: 'Lead adapters', verdict: 'high', prs: ['acme/api#6954', 'acme/api#7472', 'acme/api#7500'],
      risk: 'High: the adapters move money.', blast_radius: 'Every Lead loan from merge.',
    },
  ],
  comments: [
    ...BOARD.comments,
    { n: 7, pr: 'acme/api#8000', severity: 'low', confidence: 'proven', status: 'proposed', summary: 'The card target is untested on the wire.', body: 'Untested.' },
  ],
}

test('each stack opens as its own pane, a tab titled for the stack beside All, and a pull request in no stack is a stack of one', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens: any[] = []
  stubs(on, { board: STACKED, opens })
  await start($)

  const titles = Object.fromEntries(opens.map((o) => [o.id, o.title]))
  expect(titles).toEqual({ review: 'All', 'review-lead': 'Lead adapters', 'review-acme-api-8000': '#8000 Card target' })
  await ui_absent($)
})

async function ui_absent($) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tabs' })).toBeUndefined()
  await ui.unmount()
}

test('a stack\'s pane heads with the stack\'s own title, verdict, risk and blast, and holds only its pull requests and comments', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, { board: STACKED })
  await start($)

  const ui = await $.ui.mount({ ...PANE, requestId: 'review-lead', surface: 'terminal' })
  expect(await ui.find({ key: 'title-row', text: /Lead adapters\s*high/ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Risk\s*High: the adapters move money\./ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Blast\s*Every Lead loan from merge\./ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Lead adapters stack/ })).toBeUndefined()
  expect(await ui.find({ key: 'prs', text: /Lead adapters\s*high\s*3\s*ann, bo/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-8000' })).toBeUndefined()
  expect(await ui.find({ key: 'comment-6' })).toBeDefined()
  expect(await ui.find({ key: 'comment-7' })).toBeUndefined()
  expect(await ui.find({ key: 'section-unaddressed', text: /Loan asks payment/ })).toBeDefined()
  expect(await ui.find({ key: 'report' })).toBeUndefined()
  await ui.unmount()

  const lone = await $.ui.mount({ ...PANE, requestId: 'review-acme-api-8000', surface: 'terminal' })
  expect(await lone.find({ key: 'title-row', text: /#8000 Card target/ })).toBeDefined()
  expect(await lone.find({ key: 'comment-7' })).toBeDefined()
  expect(await lone.find({ key: 'comment-6' })).toBeUndefined()
  await lone.unmount()
})

test('All keeps the review\'s own summary, every stack under its heading, every comment and the report', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, { board: STACKED })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'title-row', text: /Lead adapters stack\s*medium/ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Risk\s*Medium: money movement behind a gate at 0%\./ })).toBeDefined()
  expect(await ui.find({ key: 'stack-lead', text: /Lead adapters\s*high\s*3\s*ann, bo/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-8000' })).toBeDefined()
  expect(await ui.find({ key: 'comment-6' })).toBeDefined()
  expect(await ui.find({ key: 'comment-7' })).toBeDefined()
  expect(await ui.find({ key: 'report' })).toBeDefined()
  await ui.unmount()
})

test('a layer by another author names them, and a layer that branches off a lower one says which', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, { board: STACKED })
  await start($)

  const ui = await $.ui.mount({ ...PANE, requestId: 'review-lead', surface: 'terminal' })
  expect(await ui.find({ key: 'prrow-7500', text: /#7500.*bo.*on #6954.*Side branch/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-7472', text: /on #|ann/ })).toBeUndefined()
  await ui.unmount()
})

test('a board that names no stacks draws one list and opens no stack panes', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens: any[] = []
  stubs(on, { opens })
  await start($)

  expect(opens.map((o) => o.id)).toEqual(['review', 'review'])
  expect(opens[0].title).toBe('Review · Lead adapters stack')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'prs', text: /Stack\s*2/ })).toBeDefined()
  await ui.unmount()
})

test('a review with no board yet lists its pull requests from the poller\'s state', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubs(on, { board: null })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /No board yet for stack-7472/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-6954' })).toBeDefined()
  expect(await ui.find({ key: 'prrow-7472' })).toBeDefined()
  await ui.unmount()
})

test('/reviewboard shows stack tabs that wait for room, and closes the board only once every tab is showing', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opens: any[] = []
  const closes: any[] = []
  const panes: any[] = [
    { id: 'review', title: 'All', isShown: true, isFocused: false, isPlaced: true },
    { id: 'review-lead', title: 'Lead adapters', isShown: false, isFocused: false, isPlaced: false },
    { id: 'review-acme-api-8000', title: '#8000 Card target', isShown: false, isFocused: false, isPlaced: false },
  ]
  stubs(on, { board: STACKED, opens, closes, panes })
  await start($)
  opens.length = 0

  await $.command.run({ command: 'reviewboard' })
  expect(closes).toEqual([])
  expect(opens.map((o) => o.id)).toEqual(expect.arrayContaining(['review-lead', 'review-acme-api-8000']))

  for (const p of panes) p.isPlaced = true
  await $.command.run({ command: 'reviewboard' })
  expect(closes.map((c) => c.id).sort()).toEqual(['review', 'review-acme-api-8000', 'review-lead'])
})

for (const placed of [false, true]) {
  test(placed ? 'All drops the hint once every stack tab is showing' : 'All says when its stack tabs are waiting for a wider terminal', async ($, on) => {
    mock.clock(on, { now: NOW })
    const panes = [
      { id: 'review', title: 'All', isShown: true, isFocused: false, isPlaced: true },
      { id: 'review-lead', title: 'Lead adapters', isShown: placed, isFocused: false, isPlaced: placed },
      { id: 'review-acme-api-8000', title: '#8000 Card target', isShown: placed, isFocused: false, isPlaced: placed },
    ]
    stubs(on, { board: STACKED, panes })
    await start($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const hint = await ui.find({ text: /Stack tabs are waiting for a wider terminal; run \/reviewboard to show them\./ })
    if (placed) expect(hint).toBeUndefined()
    else expect(hint).toBeDefined()
    await ui.unmount()
  })
}
