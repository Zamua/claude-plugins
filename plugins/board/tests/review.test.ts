import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { board, engine, HOME, json, open, PANE, start, world } from './engine'
import type { World } from './engine'
import { ghRun, pr } from './github'
import type { Pr } from './github'

const NOW = Date.parse('2026-10-21T14:00:00Z')
const row = (n: number) => `prrow-acme/api#${n}`
const SESSION = 'sess-mine'
const STATE_FILE = `${HOME}/.config/pr-review-board/state.json`
const BOARD_FILE = `${HOME}/workspace/reviews/.pr-review-board/stack-7472/board.json`
const FACTS_FILE = `${HOME}/workspace/reviews/.pr-review-board/stack-7472/github.json`
const MANUAL_FILE = `${HOME}/workspace/reviews/.pr-review-board/manual-sess-hand/board.json`

const STATE = {
  reviews: {
    'other-1': { status: 'ACTIVE', slug: 'other-1', claude_session: 'sess-other', prs: ['acme/api#1'] },
    'stack-7472': { status: 'ACTIVE', slug: 'nova-stack-6936', claude_session: SESSION, herdr_workspace: 'wT', prs: ['acme/api#6954', 'acme/api#7472'] },
    'old-9': { status: 'CLEANEDUP', slug: 'old-9', claude_session: SESSION, prs: ['acme/api#9'] },
  },
}

const BOARD = {
  schema: 2,
  updated_at: '2026-10-21T13:50:00Z',
  title: 'Nova adapters stack',
  verdict: 'medium',
  risk: 'Medium: payments behind a gate at 0%.',
  blast_radius: 'From merge, a payment outage stops legacy Nova work.',
  prs: [
    { pr: 'acme/api#6954', number: 6954, title: 'Servicing steps aside', url: 'https://github.com/acme/api/pull/6954', risk: 'medium' },
    { pr: 'acme/api#7472', number: 7472, title: 'Bank fix', url: 'https://github.com/acme/api/pull/7472', risk: 'medium' },
  ],
  report: [
    { id: 'about', title: 'What this change is about', markdown: 'Moves Nova disbursement into **payment**.' },
    { id: 'risk', title: 'Risk and blast radius', markdown: 'Medium.' },
  ],
  comments: [
    {
      n: 6, pr: 'acme/api#6954', severity: 'live', confidence: 'proven', status: 'proposed', origin: 'new',
      summary: 'A payment outage stops legacy Nova work.', body: 'With the gate off, a 503 stops servicing.',
      detail: 'Every legacy handler asks payment first.', origin_note: 'Servicing never called payment.',
      target: 'LedgerSweepConfig.kt:227', location_url: 'https://github.com/acme/api/blob/a/x.kt#L227',
      files: [
        { label: 'PartnerPathOwnership.kt:37-41', url: 'https://github.com/acme/api/blob/a/o.kt#L37-L41' },
        { label: 'LedgerSweepConfig.kt:227', url: 'https://github.com/acme/api/blob/a/x.kt#L227' },
        { label: 'ReviewOutageScratchTest', url: 'file:///reviews/stack/api-6954/ReviewOutageScratchTest.kt', kind: 'test' },
      ],
    },
    { n: 1, pr: 'acme/api#7472', severity: 'medium', confidence: 'proven', status: 'proposed', origin: 'carried', summary: 'The sweep opens a fresh replacement.', body: 'An unanswered replacement.' },
    { n: 3, pr: 'acme/api#7472', severity: 'low', confidence: 'proven', status: 'posted', summary: 'Order asks payment to replace legacy funds.', body: 'x', posted_url: 'https://github.com/acme/api/pull/7472#discussion_r1' },
    { n: 5, pr: 'acme/api#7472', severity: 'question', confidence: 'unproven', status: 'proposed', origin: 'none', summary: 'Is the description current?', body: 'Is it?' },
  ],
}

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
      id: 'nova', title: 'Nova adapters', verdict: 'high', prs: ['acme/api#6954', 'acme/api#7472', 'acme/api#7500'],
      risk: 'High: the adapters move money.', blast_radius: 'Every Nova order from merge.',
    },
  ],
  comments: [
    ...BOARD.comments,
    { n: 7, pr: 'acme/api#8000', severity: 'low', confidence: 'proven', status: 'proposed', summary: 'The card target is untested on the wire.', body: 'Untested.' },
  ],
}

// GitHub's side of the stacked review: 7472 and 7500 both branch off 6954
const GITHUB: Record<number, Pr> = {
  6954: pr({ isDraft: false, author: 'ann', headRefName: 'f/6954', reviewDecision: 'APPROVED', approvals: ['zed'] }),
  7472: pr({ isDraft: false, author: 'ann', headRefName: 'f/7472', baseRefName: 'f/6954', rollup: 'FAILURE', failing: ['build'] }),
  7500: pr({ isDraft: false, author: 'bo', headRefName: 'f/7500', baseRefName: 'f/6954', rollup: 'PENDING' }),
  8000: pr({ isDraft: false, author: 'bo', headRefName: 'f/8000' }),
}

function reviewing(
  {
    state = STATE as unknown,
    board = BOARD as unknown,
    facts = undefined as unknown,
    manual = undefined as unknown,
    session = SESSION,
    github = GITHUB,
  } = {},
): World {
  const files: Record<string, string> = {}
  if (state) files[STATE_FILE] = json(state)
  if (board) files[BOARD_FILE] = json(board)
  if (facts) files[FACTS_FILE] = json(facts)
  if (manual) files[MANUAL_FILE] = json(manual)

  return world({ session: { id: session }, env: { HERDR_WORKSPACE_ID: 'wZ' }, files, run: ghRun(github) })
}

const mount = ($: Engine, bodyColumns = 60) =>
  $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })

/** The review view narrowed to one stack by its button. */
async function inStack($: Engine, stack: string) {
  const ui = await mount($)
  await ui.press({ key: `stack-tab-${stack}` })

  return ui
}

test('the pane opens on the live review this session recorded, not another session\'s or a cleaned-up one', async ($, on) => {
  const w = reviewing()
  engine(on, w, NOW)
  await start($)

  expect(w.opens[0]).toMatchObject({ id: 'board' })
  const ui = await mount($)
  expect(await ui.find({ key: 'tab-review', text: 'review 3' })).toBeDefined()
  expect(await ui.find({ key: 'title-row', text: /Nova adapters stack\s*medium/ })).toBeDefined()
  expect(await ui.find({ key: row(6954) })).toBeDefined()
  expect(await ui.find({ key: row(1) })).toBeUndefined()
  await ui.unmount()
})

test('a review run by hand is found by the board its skill keys with this session\'s id', async ($, on) => {
  const w = reviewing({ state: { reviews: {} }, board: undefined, manual: { ...BOARD, title: 'By hand' }, session: 'sess-hand' })
  engine(on, w, NOW)
  await start($)

  expect(w.opens[0]).toMatchObject({ id: 'board' })
  const ui = await mount($)
  expect(await ui.find({ key: 'title-row', text: /^By hand/ })).toBeDefined()
  expect(await ui.find({ key: 'section-live', text: /A payment outage stops legacy Nova work/ })).toBeDefined()
  await ui.unmount()
})

test('comments sit in bordered sections by severity, live-on-merge first and questions last', async ($, on) => {
  engine(on, reviewing(), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'section-live' })).toMatchObject({ props: { borderStyle: 'round', borderColor: 'error' } })
  expect(await ui.find({ key: 'section-live', text: /A payment outage stops legacy Nova work/ })).toBeDefined()
  expect(await ui.find({ key: 'section-medium', text: /The sweep opens a fresh replacement/ })).toBeDefined()
  expect(await ui.find({ key: 'section-question', text: /Is the description current/ })).toBeDefined()
  expect(await ui.find({ key: 'section-live', text: /Is the description current/ })).toBeUndefined()
  const order = (await ui.findAll({ type: 'Box' })).map(b => b.key)
  expect(order.indexOf('section-live')).toBeLessThan(order.indexOf('section-question'))
  await ui.unmount()
})

test('a comment opens in place to show the exact text it posts, the finding, and where it comes from', async ($, on) => {
  engine(on, reviewing(), NOW)
  await start($)

  const ui = await mount($)
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
  engine(on, reviewing(), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'report', text: /What this change is about\s*▸ Risk and blast radius/ })).toBeDefined()
  expect(await ui.find({ key: 'report-md-about' })).toBeUndefined()
  await ui.press({ key: 'report-about' })
  expect(await ui.find({ key: 'report-md-about' })).toMatchObject({ props: { text: 'Moves Nova disbursement into **payment**.' } })
  expect(await ui.find({ key: 'report-md-risk' })).toBeUndefined()
  const order = (await ui.findAll({ type: 'Box' })).map(b => b.key)
  expect(order.indexOf('report')).toBeGreaterThan(order.indexOf('section-question'))
  expect(order.indexOf('report')).toBeGreaterThan(order.indexOf('section-unaddressed'))
  await ui.unmount()
})

test('ticked comments draft the post command into the prompt box, and a posted one cannot be ticked', async ($, on) => {
  const w = reviewing()
  engine(on, w, NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'pick-3' })).toBeUndefined()
  await ui.press({ key: 'pick-6' })
  await ui.press({ key: 'pick-1' })
  await ui.press({ key: 'fill' })
  expect(w.fills).toEqual([expect.objectContaining({ text: 'post 1, 6' })])
  await ui.press({ key: 'pick-6' })
  await ui.press({ key: 'fill' })
  expect(w.fills[1]).toMatchObject({ text: 'post 1' })
  await ui.unmount()
})

test('the stack sits under the risk and blast lines, above the comments, and each comment links its PR again', async ($, on) => {
  engine(on, reviewing(), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'summary', text: /Risk\s*Medium: payments behind a gate at 0%\./ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Blast\s*From merge, a payment outage stops legacy Nova work\./ })).toBeDefined()
  const order = (await ui.findAll({ type: 'Box' })).map(b => b.key)
  expect(order.indexOf('prs')).toBeGreaterThan(order.indexOf('summary'))
  expect(order.indexOf('prs')).toBeLessThan(order.indexOf('section-live'))
  const links = (await ui.findAll({ type: 'Link' })).map(l => [l.props.label, l.props.href])
  expect(links.filter(([label, href]) => label === '#6954' && href === 'https://github.com/acme/api/pull/6954').length).toBe(2)
  expect(await ui.find({ key: 'head-6', text: /#6954/ })).toBeDefined()
  await ui.unmount()
})

test('a dropped comment falls off the board, whatever its severity or origin', async ($, on) => {
  const dropped = [
    { n: 9, pr: 'acme/api#7472', severity: 'low', confidence: 'proven', status: 'dropped', origin: 'carried', status_note: 'Fixed in abc1234.', summary: 'A declined resend fails the fund.', body: 'x' },
    { n: 10, pr: 'acme/api#7472', severity: 'low', confidence: 'proven', status: 'dropped', origin: 'none', summary: 'Reply to Bugbot.', body: 'x' },
  ]
  engine(on, reviewing({ board: { ...BOARD, comments: [...BOARD.comments, ...dropped] } }), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'head-9' })).toBeUndefined()
  expect(await ui.find({ key: 'head-10' })).toBeUndefined()
  expect(await ui.find({ text: /declined resend fails the fund|Reply to Bugbot|dropped/ })).toBeUndefined()
  expect(await ui.find({ key: 'section-medium', text: /The sweep opens a fresh replacement/ })).toBeDefined()
  await ui.unmount()
})

test('each comment says whether it is a new bug, one carried over, or not a bug, and the summary does not count them', async ($, on) => {
  engine(on, reviewing(), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'head-6', text: /#6954\s*new/ })).toBeDefined()
  expect(await ui.find({ key: 'head-1', text: /#7472\s*carried over/ })).toBeDefined()
  expect(await ui.find({ key: 'head-5', text: /not a bug/ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /comments ·|proven|carried over/ })).toBeUndefined()
  await ui.unmount()
})

test('a posted comment leaves its severity section for Unaddressed, and moves to Addressed once marked, where alone its note shows', async ($, on) => {
  const comments = BOARD.comments.map(c => (c.status === 'posted' ? { ...c, addressed_note: 'Partly fixed' } : c))
  const marked = {
    ...BOARD,
    comments: [
      ...comments,
      { n: 8, pr: 'acme/api#6954', severity: 'medium', confidence: 'proven', status: 'posted', addressed: true, addressed_note: 'Fixed in abc1234.', summary: 'The retry drops the lock.', body: 'x', posted_url: 'https://github.com/acme/api/pull/6954#discussion_r8' },
    ],
  }
  engine(on, reviewing({ board: marked }), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'section-low' })).toBeUndefined()
  expect(await ui.find({ key: 'section-unaddressed', text: /Unaddressed\s*1\s*3\s*#7472\s*comment\s*Order asks payment to replace legacy funds/ })).toBeDefined()
  expect(await ui.find({ key: 'section-unaddressed', text: /retry drops the lock|Partly fixed/ })).toBeUndefined()
  expect(await ui.find({ key: 'section-addressed', text: /Addressed\s*1\s*8\s*#6954\s*comment\s*The retry drops the lock\.\s*Fixed in abc1234\./ })).toBeDefined()
  expect(await ui.find({ key: 'title-row', text: /^Nova adapters stack\s*medium$/ })).toBeDefined()
  const links = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
  expect(links).toContain('https://github.com/acme/api/pull/7472#discussion_r1')
  await ui.unmount()
})

test('a comment links its anchor, the code it cites, and its scratch test, each file once', async ($, on) => {
  engine(on, reviewing(), NOW)
  await start($)

  const ui = await mount($)
  expect((await ui.find({ key: 'files-6' }))?.text).toMatch(/LedgerSweepConfig\.kt:227\s*PartnerPathOwnership\.kt:37-41\s*test: ReviewOutageScratchTest/)
  const links = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
  expect(links.filter(h => h === 'https://github.com/acme/api/blob/a/x.kt#L227').length).toBe(1)
  expect(links).toContain('file:///reviews/stack/api-6954/ReviewOutageScratchTest.kt')
  await ui.unmount()
})

test('a session that runs no review opens no pane unasked, lists no review, and opened by name says where its board would go', async ($, on) => {
  const w = reviewing({ session: 'sess-nobody' })
  engine(on, w, NOW)
  await start($)

  expect(w.opens).toEqual([])
  const plain = await open($)
  expect(await plain.find({ key: 'tab-review' })).toBeUndefined()
  await plain.unmount()
  await board($, '')
  const ui = await open($, 'review')
  expect(await ui.find({ text: /runs no pr-review-board review/ })).toBeDefined()
  expect(await ui.find({ text: /\/home\/test\/workspace\/reviews\/\.pr-review-board\/manual-sess-nobody\/board\.json/ })).toBeDefined()
  await ui.unmount()
})

test('a board that names no stacks draws one list and no stack buttons', async ($, on) => {
  engine(on, reviewing(), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'prs', text: /^Stack.*#6954.*#7472/ })).toBeDefined()
  expect(await ui.find({ key: 'stack-tabs' })).toBeUndefined()
  await ui.unmount()
})

test('a stacked board offers All and one button per stack, a pull request in no stack being a stack of one', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'stack-tabs', text: /^All\s*·\s*Nova adapters\s*·\s*#8000 Card target$/ })).toBeDefined()
  expect(await ui.find({ key: 'stack-tab-all' })).toBeDefined()
  expect(await ui.find({ key: 'stack-tab-nova' })).toBeDefined()
  expect(await ui.find({ key: 'stack-tab-acme/api#8000' })).toBeDefined()
  await ui.unmount()
})

test('a stack\'s view heads with the stack\'s own title, verdict, risk and blast, and holds only its pull requests and comments', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: 'title-row', text: /Nova adapters\s*high/ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Risk\s*High: the adapters move money\./ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Blast\s*Every Nova order from merge\./ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Nova adapters stack/ })).toBeUndefined()
  expect(await ui.find({ key: 'prs-heading', text: /^Nova adapters\s*high$/ })).toBeDefined()
  expect(await ui.find({ key: row(8000) })).toBeUndefined()
  expect(await ui.find({ key: 'comment-6' })).toBeDefined()
  expect(await ui.find({ key: 'comment-7' })).toBeUndefined()
  expect(await ui.find({ key: 'section-unaddressed', text: /Order asks payment/ })).toBeDefined()
  expect(await ui.find({ key: 'report' })).toBeUndefined()

  await ui.press({ key: 'stack-tab-acme/api#8000' })
  expect(await ui.find({ key: 'title-row', text: /#8000 Card target/ })).toBeDefined()
  expect(await ui.find({ key: 'comment-7' })).toBeDefined()
  expect(await ui.find({ key: 'comment-6' })).toBeUndefined()

  await ui.press({ key: 'stack-tab-all' })
  expect(await ui.find({ key: 'report' })).toBeDefined()
  await ui.unmount()
})

test('pull requests draw as on the prs board: stack glyphs from GitHub, a dot and a word for CI, and no risk', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: row(6954), text: /^┌.*#6954/ })).toBeDefined()
  expect(await ui.find({ key: row(7472), text: /^├.*#7472/ })).toBeDefined()
  expect(await ui.find({ key: row(7500), text: /^└.*#7500/ })).toBeDefined()
  expect(await ui.find({ key: row(8000), text: /[┌├└]/ })).toBeUndefined()
  expect(await ui.find({ key: 'state-acme/api#7472', text: 'CI fail' })).toBeDefined()
  expect((await ui.find({ key: 'dot-acme/api#7472' }))?.children[0]).toMatchObject({ props: { color: 'error' } })
  expect(await ui.find({ key: 'state-acme/api#7500', text: 'CI run' })).toBeDefined()
  expect((await ui.find({ key: 'dot-acme/api#7500' }))?.children[0]).toMatchObject({ props: { color: 'warning' } })
  expect((await ui.find({ key: 'group-nova' }))?.props.marginTop || 0).toBe(0)
  expect(await ui.find({ key: 'group-acme/api#8000' })).toMatchObject({ props: { marginTop: 1 } })

  await ui.press({ key: 'stack-tab-nova' })
  expect(await ui.find({ key: row(6954), text: /^┌.*#6954/ })).toBeDefined()
  await ui.unmount()
})

test('a pull request both the prs board and the review list is asked of GitHub once', async ($, on) => {
  const w = reviewing({ board: STACKED })
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: 'mcp__board__prs', add: [{ pr: 'acme/api#6954' }] })
  expect(w.runs.filter(argv => argv.join(' ').includes('pullRequest(number: 6954)'))).toHaveLength(1)
})

test('pressing a stack\'s title in All narrows the view to that stack', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await mount($)
  await ui.press({ key: 'goto-nova' })
  expect(await ui.find({ key: 'title-row', text: /^Nova adapters\s*high/ })).toBeDefined()
  expect(await ui.find({ key: row(8000) })).toBeUndefined()
  await ui.unmount()
})

test('All keeps the review\'s own summary, every stack under its heading, every comment and the report', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ key: 'title-row', text: /Nova adapters stack\s*medium/ })).toBeDefined()
  expect(await ui.find({ key: 'summary', text: /Risk\s*Medium: payments behind a gate at 0%\./ })).toBeDefined()
  expect(await ui.find({ key: 'stack-nova', text: /^Nova adapters\s*high$/ })).toBeDefined()
  expect(await ui.find({ key: row(8000) })).toBeDefined()
  expect(await ui.find({ key: 'comment-6' })).toBeDefined()
  expect(await ui.find({ key: 'comment-7' })).toBeDefined()
  expect(await ui.find({ key: 'report' })).toBeDefined()
  await ui.unmount()
})

test('a pull request GitHub has approved gets a green check left of its number, and one not yet approved keeps the column empty', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: 'mark-acme/api#6954', text: '✓' })).toMatchObject({ props: { width: 1 } })
  expect(await ui.find({ key: row(6954), text: /✓.*#6954/ })).toBeDefined()
  expect(await ui.find({ key: 'mark-acme/api#7472' })).toMatchObject({ props: { width: 1 } })
  expect(await ui.find({ key: row(7472), text: /✓/ })).toBeUndefined()
  await ui.unmount()
})

test('the warning mark means a thread waits on you, as on the prs board, not that the operator\'s own threads are open', async ($, on) => {
  const github = { ...GITHUB, 7472: { ...(GITHUB[7472] as Pr), threads: [{ isResolved: false, opener: 'octo', by: 'ann' }] } }
  const board = { ...STACKED, prs: STACKED.prs.map(p => (p.number === 7500 ? { ...p, other_open_threads: 2 } : p)) }
  engine(on, reviewing({ board, github }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: 'flag-acme/api#7472', text: '!' })).toMatchObject({ props: { width: 1 } })
  expect(await ui.find({ key: 'flag-acme/api#7500' })).toMatchObject({ props: { width: 1 } })
  expect(await ui.find({ key: row(7500), text: /!/ })).toBeUndefined()
  expect(await ui.find({ key: row(6954), text: /!/ })).toBeUndefined()
  await ui.unmount()
})

test('a stack whose posted comments are all addressed, with nothing else waiting, says so', async ($, on) => {
  const settled = {
    ...STACKED,
    comments: [{ n: 8, pr: 'acme/api#6954', severity: 'low', confidence: 'proven', status: 'posted', addressed: true, summary: 'x', body: 'x', posted_url: 'https://github.com/acme/api/pull/6954#discussion_r8' }],
  }
  engine(on, reviewing({ board: settled }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: 'title-row', text: /Nova adapters\s*high\s*all addressed/ })).toBeDefined()
  await ui.unmount()
})

test('open threads the board did not post keep a stack from reading as all addressed', async ($, on) => {
  const board = { ...STACKED, comments: [], prs: STACKED.prs.map(p => (p.number === 6954 ? { ...p, other_open_threads: 1 } : p)) }
  engine(on, reviewing({ board }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: 'title-row', text: /all addressed/ })).toBeUndefined()
  await ui.unmount()
})

test('a thread the operator opened, from github.json, keeps a stack from reading as all addressed while it waits', async ($, on) => {
  const settled = {
    ...STACKED,
    comments: [{ n: 8, pr: 'acme/api#6954', severity: 'low', confidence: 'proven', status: 'posted', addressed: true, summary: 'x', body: 'x', posted_url: 'https://github.com/acme/api/pull/6954#discussion_r8' }],
  }
  const facts = { prs: { 'acme/api#7472': { threads: [{ url: 'https://github.com/acme/api/pull/7472#discussion_r9', resolved: false, replied: false }] } } }
  engine(on, reviewing({ board: settled, facts }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: 'title-row', text: /Nova adapters\s*high/ })).toBeDefined()
  expect(await ui.find({ key: 'title-row', text: /all addressed/ })).toBeUndefined()
  await ui.unmount()
})

test('a merged pull request shows a purple diamond and a closed one a red cross where the approval check sits', async ($, on) => {
  const github = { ...GITHUB, 6954: { ...(GITHUB[6954] as Pr), state: 'MERGED' as const }, 7472: { ...(GITHUB[7472] as Pr), state: 'CLOSED' as const } }
  engine(on, reviewing({ board: STACKED, github }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect((await ui.find({ key: 'mark-acme/api#6954', text: '◆' }))?.children[0]).toMatchObject({ props: { color: 'merged' } })
  expect((await ui.find({ key: 'mark-acme/api#7472', text: '✕' }))?.children[0]).toMatchObject({ props: { color: 'error' } })
  expect(await ui.find({ key: 'state-acme/api#6954', text: 'merged' })).toBeDefined()
  await ui.unmount()
})

test('GitHub decides authors, approvals and bases over what the board wrote, and the stamp says when it was checked', async ($, on) => {
  const board = { ...STACKED, prs: STACKED.prs.map(p => (p.number === 7472 ? { ...p, approved: true, author: 'stale', base: undefined } : p)) }
  const github = { ...GITHUB, 7472: { ...(GITHUB[7472] as Pr), author: 'dee' } }
  engine(on, reviewing({ board, github }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: 'mark-acme/api#7472', text: '✓' })).toBeUndefined()
  expect(await ui.find({ key: row(7472), text: /#7472.*dee.*Bank fix/ })).toBeDefined()
  expect(await ui.find({ key: row(7472), text: /^├/ })).toBeDefined()
  expect(await ui.find({ key: 'stamp', text: 'Updated 10m ago · GitHub checked just now' })).toBeDefined()
  await ui.unmount()
})

test('every layer names its author in a column as wide as the longest, and a layer that branches off a lower one says which', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await inStack($, 'nova')
  expect(await ui.find({ key: row(6954), text: /#6954.*ann.*Servicing steps aside/ })).toBeDefined()
  expect(await ui.find({ key: row(7472), text: /#7472.*ann.*Bank fix/ })).toBeDefined()
  expect(await ui.find({ key: row(7500), text: /#7500.*bo.*on #6954.*Side branch/ })).toBeDefined()
  expect(await ui.find({ key: row(7472), text: /on #/ })).toBeUndefined()
  expect(await ui.find({ key: 'author-acme/api#6954' })).toMatchObject({ props: { width: 3 } })
  expect(await ui.find({ key: 'author-acme/api#7500' })).toMatchObject({ props: { width: 3 } })

  await ui.press({ key: 'stack-tab-all' })
  expect(await ui.find({ key: row(8000), text: /#8000.*bo.*Card target/ })).toBeDefined()
  expect(await ui.find({ key: 'author-acme/api#8000' })).toMatchObject({ props: { width: 3 } })
  await ui.unmount()
})

test('a narrow pane keeps each pull request\'s number, dot and base whole and leaves the title to give way', async ($, on) => {
  engine(on, reviewing({ board: STACKED }), NOW)
  await start($)

  const ui = await mount($, 30)
  for (const n of [6954, 7472, 8000]) {
    expect(await ui.find({ key: `prnum-acme/api#${n}` })).toMatchObject({ type: 'Box', props: { flexShrink: 0 }, text: `#${n}` })
    expect(await ui.find({ key: `dot-acme/api#${n}` })).toMatchObject({ props: { flexShrink: 0 } })
  }
  expect(await ui.find({ key: 'base-acme/api#7500' })).toMatchObject({ props: { flexShrink: 0 }, text: 'on #6954' })
  const line = await ui.find({ key: row(6954) })
  const title = line?.children.at(-1) as { props: Record<string, unknown> }
  expect(title.props).toMatchObject({ wrap: 'truncate-end' })
  expect(title.props.flexShrink).toBeUndefined()
  await ui.unmount()
})

test('a review with no board yet lists its pull requests from the poller\'s state', async ($, on) => {
  engine(on, reviewing({ board: null }), NOW)
  await start($)

  const ui = await mount($)
  expect(await ui.find({ text: /No board yet for stack-7472/ })).toBeDefined()
  expect(await ui.find({ key: row(6954) })).toBeDefined()
  expect(await ui.find({ key: row(7472) })).toBeDefined()
  await ui.unmount()
})
