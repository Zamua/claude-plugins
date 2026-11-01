import { expect, test } from 'claude-code/testing'

import { engine, HOME, json, open, start } from './engine'
import { herdrHost, prsBoard, storeFile, TREE, trackedPr, withLive } from './work-fixtures'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const TOOL = 'mcp__board__work'
const at = '2026-10-27T13:00:00Z'
// The tests run as `s1`, the root session in w1:p1
const ROOT = { id: 'w1:p1', label: 'root', harnessId: 's1' }
const ROOT_ID = 'session:herdr:default/w1:p1'
const CACHE_FILE = `${HOME}/.cache/board/github.json`
const META = `${HOME}/workspace/reviews/.pr-review-board`

const SECTIONED = {
  ...TREE,
  root: ROOT_ID,
  sections: ['Goals', 'Side'],
  section_of: { 'file:pay': 'Goals', 'file:tooling': 'Side' },
  items: TREE.items.map(item =>
    item.id === 'fee' ? { ...item, aliases: ['ABC-809'] } : item.id === 'hostit' ? { ...item, aliases: ['HOST-1'] } : item,
  ),
}

/** The shared GitHub cache holding each pull request's facts as just fetched, so nothing asks GitHub. */
function cacheOf(prs: ReturnType<typeof trackedPr>[]) {
  const entries = Object.fromEntries(prs.map(p => [p.key, { facts: p.facts, at: NOW, v: 4 }]))

  return { [CACHE_FILE]: json({ prs: entries, viewer: 'me' }) }
}

test('a pull request whose title names no Item sits under the Item of the session that tracks it', async ($, on) => {
  const panes = [{ id: 'w4:p1', label: 'scope-work', harnessId: 'h1' }]
  const file = { ...TREE, links: [{ child: 'session:herdr:default/w4:p1', parent: 'file:scope', at }] }
  const held = { ...prsBoard('h1', [trackedPr(7503, 'Unrelated cleanup')]), ...prsBoard('h9', [trackedPr(7504, 'Another cleanup')]) }
  engine(on, withLive(file, herdrHost(panes), storeFile(held)), NOW)
  await start($)

  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(read).toMatch(/file:scope #4 [^\n]*\n\s+session:herdr:default\/w4:p1 [^\n]*\n\s+pr:acme\/api#7503 \[waiting\] Unrelated cleanup/)
  expect(read).not.toMatch(/file:scope[^\n]*\n(\s+.*\n)*\s+pr:acme\/api#7504/)
})

test("the root's pull request rollup has a tab per section, each top-level Item a heading, what needs you first", async ($, on) => {
  const prs = [
    trackedPr(7600, 'ABC-809 adds the fee lookup', { author: 'lee' }),
    trackedPr(7502, 'ABC-809 adds the gross fee leg', { ci: 'fail', failing: ['build'] }),
    trackedPr(7400, 'ABC-809 adds the fee table', { state: 'MERGED' }),
    trackedPr(8100, 'HOST-1 adds search'),
  ]
  const w = withLive(SECTIONED, herdrHost([ROOT]), { ...storeFile(prsBoard('h9', prs)), ...cacheOf(prs) })
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'allprs')
  expect(await ui.find({ key: 'tab-allprs', text: 'all prs 1' })).toBeDefined()
  expect(await ui.find({ key: 'rptab-goals', text: 'Goals 1' })).toBeDefined()
  expect(await ui.find({ key: 'rptab-side', text: 'Side' })).toBeDefined()
  expect(await ui.find({ key: 'rprs', text: /Payments rework.*#7502.*CI fail.*#7600.*lee/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-acme/api#7400' })).toBeUndefined()

  await ui.press({ key: 'rdone' })
  expect(await ui.find({ key: 'prrow-acme/api#7400', text: /merged/ })).toBeDefined()
  await ui.press({ key: 'rptab-side' })
  expect(await ui.find({ key: 'rprs', text: /Tooling.*#8100/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-acme/api#7502' })).toBeUndefined()
  await ui.unmount()
  expect(w.runs.some(argv => argv[0] === 'gh')).toBe(false)
})

test('a session that is not the root has no rollup tabs', async ($, on) => {
  const prs = [trackedPr(7502, 'ABC-809 adds the gross fee leg')]
  const file = { ...SECTIONED, root: 'session:herdr:default/w9:p1' }
  engine(on, withLive(file, herdrHost([ROOT]), { ...storeFile(prsBoard('h9', prs)), ...cacheOf(prs) }), NOW)
  await start($)

  const ui = await open($, 'work')
  expect(await ui.find({ key: 'tab-work' })).toBeDefined()
  expect(await ui.find({ key: 'tab-allprs' })).toBeUndefined()
  expect(await ui.find({ key: 'tab-allreviews' })).toBeUndefined()
  await ui.unmount()
})

const thread = (n: number, more: Record<string, boolean> = {}) => ({ url: `https://github.com/acme/api/pull/7700#discussion_r${n}`, resolved: false, replied: false, ...more })

const REVIEWS = {
  [`${HOME}/.config/pr-review-board/state.json`]: json({
    last_poll: Date.parse('2026-10-27T13:58:00Z') / 1000,
    reviews: {
      'stack-1': { status: 'ACTIVE', slug: 'nova-stack', claude_session: 'h-r1', prs: ['acme/api#7700', 'acme/api#7701'] },
      'one-8': { status: 'ACTIVE', slug: 'one-8', claude_session: 'h-r2', prs: ['acme/api#8288'] },
      'old-1': { status: 'CLEANEDUP', slug: 'old-1', claude_session: 'h-r1', prs: ['acme/api#1'] },
    },
  }),
  [`${META}/stack-1/board.json`]: json({
    updated_at: '2026-10-27T13:50:00Z',
    title: 'Nova stack',
    prs: [
      { pr: 'acme/api#7700', number: 7700, title: 'Adapter' },
      { pr: 'acme/api#7701', number: 7701, title: 'Client' },
    ],
    comments: [
      { n: 1, pr: 'acme/api#7700', status: 'dropped', summary: 'A gap.' },
      { n: 2, pr: 'acme/api#7700', status: 'posted', addressed: false, posted_url: 'https://github.com/acme/api/pull/7700#discussion_r1' },
      { n: 3, pr: 'acme/api#7700', status: 'posted', addressed: true, posted_url: 'https://github.com/acme/api/pull/7700#discussion_r5' },
      { n: 4, pr: 'acme/api#7701', status: 'posted', addressed: false, posted_url: 'https://github.com/acme/api/pull/7701#discussion_r6' },
    ],
  }),
  [`${META}/stack-1/github.json`]: json({
    prs: {
      'acme/api#7700': { state: 'OPEN', approved: false, threads: [thread(1), thread(2, { resolved: true }), thread(4), thread(5)] },
      'acme/api#7701': { state: 'MERGED', threads: [thread(6)] },
    },
  }),
  [`${META}/one-8/board.json`]: json({
    updated_at: '2026-10-25T14:00:00Z',
    title: 'Legacy removal',
    prs: [{ pr: 'acme/api#8288', number: 8288 }],
    comments: [{ n: 1, pr: 'acme/api#8288', status: 'posted', addressed: true }],
  }),
  [`${META}/one-8/github.json`]: json({ prs: { 'acme/api#8288': { state: 'OPEN', approved: true, threads: [thread(3, { resolved: true })] } } }),
  [`${META}/manual-h-r3/board.json`]: json({
    title: 'Architecture watch',
    prs: [{ pr: 'acme/api#7502', number: 7502 }],
    comments: [{ n: 1, pr: 'acme/api#7502', status: 'proposed', summary: 'A seam.' }],
  }),
}

test("the root's review rollup says where each review stands, in the tab of its session's Item or its pull request's", async ($, on) => {
  const panes = [ROOT, { id: 'w2:p1', label: 'nova-review', harnessId: 'h-r1' }, { id: 'w3:p1', label: 'legacy-review', harnessId: 'h-r2' }]
  const links = [
    { child: 'session:herdr:default/w2:p1', parent: 'file:fee', at },
    { child: 'session:herdr:default/w3:p1', parent: 'file:tooling', at },
  ]
  const prs = [trackedPr(7502, 'ABC-809 adds the gross fee leg')]
  const w = withLive({ ...SECTIONED, links }, herdrHost(panes), { ...storeFile(prsBoard('h9', prs)), ...cacheOf(prs), ...REVIEWS })
  engine(on, w, NOW)
  await start($)

  const ui = await open($, 'allreviews')
  expect(await ui.find({ key: 'tab-allreviews', text: 'all reviews 1' })).toBeDefined()
  expect(await ui.find({ key: 'rrtab-goals', text: 'Goals 1' })).toBeDefined()
  expect(await ui.find({ key: 'rrtabs', text: /Goals 1·Side\s*polled 2m ago$/ })).toBeDefined()
  // Comment 2 waits on its author and thread 4 is another of the operator's; 3 is addressed and 6 sits on a merged one
  expect(await ui.find({ key: 'rrrow-stack-1', text: /^▸\s+Nova stack\s+2 threads\s+1 PR\s+10m/ })).toBeDefined()
  expect(await ui.find({ key: 'rrrow-manual-h-r3', text: /Architecture watch\s+1 to pick\s+1 PR\s/ })).toBeDefined()
  expect(await ui.find({ key: 'rrrow-old-1' })).toBeUndefined()

  await ui.press({ key: 'rrtoggle-stack-1' })
  expect(await ui.find({ key: 'prrow-acme/api#7700', text: /Adapter/ })).toBeDefined()
  expect(await ui.find({ key: 'prrow-acme/api#7701' })).toBeUndefined()
  await ui.press({ key: 'rrmark-stack-1' })
  expect(w.runs).toContainEqual(['herdr', '--session', 'default', 'workspace', 'focus', 'w2'])

  await ui.press({ key: 'rrtab-side' })
  expect(await ui.find({ key: 'rrrow-one-8', text: /^▸ ✓ Legacy removal\s+1 PR\s+2d/ })).toBeDefined()
  await ui.unmount()
})
