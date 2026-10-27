import { expect, test } from 'claude-code/testing'

import { board, engine, open, PANE, start, world } from './engine'

const TOOL = 'mcp__board__prs'
const NOW = Date.parse('2026-10-25T12:00:00Z')
const BOTTOM = 'https://github.com/acme/api/pull/6047'
const TOP = 'https://github.com/acme/api/pull/6050'

type Pr = {
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  headRefName: string
  baseRefName: string
  rollup: string
  failing: string[]
  threads: { isResolved: boolean; by: string }[]
  approvals?: string[]
  author?: string
}

const pr = (over: Partial<Pr>): Pr => ({
  title: 'A change',
  state: 'OPEN',
  isDraft: true,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'REVIEW_REQUIRED',
  headRefName: 'feature/x',
  baseRefName: 'main',
  rollup: 'SUCCESS',
  failing: [],
  threads: [],
  ...over,
})

function asGraphql(p: Pr) {
  return {
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    reviewDecision: p.reviewDecision,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    headRefOid: 'abc123',
    author: { login: p.author ?? 'octo' },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: p.rollup,
              contexts: {
                nodes: [
                  ...p.failing.map(name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' })),
                  { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
              },
            },
          },
        },
      ],
    },
    reviewThreads: {
      nodes: p.threads.map((t, at) => ({
        isResolved: t.isResolved,
        comments: { nodes: [{ author: { login: t.by }, url: `https://github.com/t/${at}` }] },
      })),
    },
    latestReviews: { nodes: (p.approvals ?? []).map(login => ({ author: { login }, state: 'APPROVED' })) },
  }
}

/** A world whose gh answers GitHub's GraphQL from `github`, keyed by pull request number. */
function gh(github: Record<number, Pr>, budget?: { remaining: number; resetAt: string }) {
  return world({
    run: argv => {
      if (argv[0] !== 'gh') return undefined
      const query = argv[argv.length - 1] ?? ''
      const data: Record<string, unknown> = { viewer: { login: 'octo' }, ...(budget && { rateLimit: budget }) }
      for (const [, alias, number] of query.matchAll(/(p\d+): repository\([^)]*\) \{ pullRequest\(number: (\d+)\)/g)) {
        const found = github[Number(number)]
        data[alias as string] = { pullRequest: found ? asGraphql(found) : null }
      }

      return { exitCode: 0, stdout: JSON.stringify({ data }), stderr: '' }
    },
  })
}

test('a pull request opened with gh pr create joins the board with its GitHub state', async ($, on) => {
  const w = gh({
    6050: pr({
      title: 'Nets the held reserve',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      threads: [
        { isResolved: true, by: 'octo' },
        { isResolved: false, by: 'cursor' },
        { isResolved: false, by: 'octo' },
      ],
    }),
  })
  engine(on, w, NOW)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: `${TOP}\n`, stderr: '', interrupted: false },
    text: `${TOP}\n`,
  }))
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --title x' })
  expect(ran.context?.join('\n')).toContain('now tracks acme/api#6050')
  expect(w.opens).toContainEqual(expect.objectContaining({ id: 'board' }))
  await $.tool.call({ tool: TOOL })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'board',
      component: 'Pane',
      requestId: 'board',
      surface,
      props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ key: 'tab-prs', text: 'prs 1' })).toBeDefined()
    expect(await ui.find({ key: 'switcher', text: /^session\s*·\s*prs 1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Nets the held reserve/ })).toBeDefined()
    expect(await ui.find({ key: 'stamp', text: 'GitHub checked just now' })).toBeDefined()
    expect(await ui.find({ key: 'prrow-acme/api#6050', text: /^!\s*#6050/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a pull request based on another tracked one sits above it in one stack', async ($, on) => {
  engine(
    on,
    gh({
      6047: pr({ title: 'Fee lookup', headRefName: 'feature/ac-818' }),
      6050: pr({ title: 'Reserve netting', headRefName: 'feature/ac-819', baseRefName: 'feature/ac-818' }),
    }),
    NOW,
  )
  await start($)

  const read = await $.tool.call({
    tool: TOOL,
    add: [{ pr: TOP, note: 'Rebase onto main' }, { pr: 'acme/api#6047' }],
  })
  const text = String(read.result)
  expect(text.indexOf('#6047')).toBeLessThan(text.indexOf('#6050'))
  expect(text).toContain('on #6047')
  expect(text).toContain('note: Rebase onto main')

  const ui = await open($, 'prs')
  expect(await ui.find({ type: 'Text', text: /^Stack$/ })).toBeDefined()
  const rows = (await ui.find({ key: 'prs' }))?.text ?? ''
  expect(rows.indexOf('#6047')).toBeLessThan(rows.indexOf('#6050'))
  await ui.unmount()
})

test('each git stack in a named group draws as one run, bottom first, marked ┌ ├ └, with lone pull requests after', async ($, on) => {
  const url = (n: number) => `https://github.com/acme/api/pull/${n}`
  engine(
    on,
    gh({
      8111: pr({ title: 'pays a payout', headRefName: 'pay' }),
      8117: pr({ title: 'settles a payout', headRefName: 'settle', baseRefName: 'pay' }),
      8118: pr({ title: 'sweeps payouts', headRefName: 'sweep', baseRefName: 'settle' }),
      8139: pr({ title: 'funds push-to-card', headRefName: 'fund' }),
      8145: pr({ title: 'sweeps draws', headRefName: 'draws', baseRefName: 'fund' }),
      8042: pr({ title: 'adds card calls', state: 'MERGED', headRefName: 'calls' }),
      8047: pr({ title: 'adds the draw', headRefName: 'draw' }),
    }),
    NOW,
  )
  await start($)
  const order = [8111, 8139, 8042, 8047, 8117, 8145, 8118]
  await $.tool.call({ tool: TOOL, add: order.map(n => ({ pr: url(n), stack: 'Push to card' })) })

  const ui = await open($, 'prs')
  const rows = (await ui.find({ key: 'prs' }))?.text ?? ''
  const drawn = [...rows.matchAll(/#(\d{4})/g)].map(m => Number(m[1]))
  expect(drawn).toEqual([8111, 8117, 8118, 8139, 8145, 8042, 8047])
  const glyph = async (n: number) => (await ui.find({ key: `chain-acme/api#${n}` }))?.text ?? ''
  expect(await Promise.all(drawn.map(glyph))).toEqual(['┌', '├', '└', '┌', '└', '', ''])
  expect(rows).not.toContain('on #')
  await ui.unmount()
})

test('a pull request approved in a repo that requires no review still gets its check', async ($, on) => {
  engine(on, gh({ 6050: pr({ isDraft: false, reviewDecision: null, approvals: ['berkay', 'mert'] }) }), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: TOP }] })

  const ui = await open($, 'prs')
  expect(await ui.find({ key: 'mark-acme/api#6050', text: '✓' })).toBeDefined()
  await ui.unmount()
})

test('the state word says what stops a pull request merging, and ready only once it can', async ($, on) => {
  const prs: Record<number, Pr> = {
    6001: pr({ isDraft: false, approvals: ['mert'], reviewDecision: 'APPROVED' }),
    6002: pr({ isDraft: false, reviewDecision: 'APPROVED', rollup: 'FAILURE', failing: ['build'] }),
    6003: pr({ isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    6004: pr({ isDraft: false }),
    6005: pr({ isDraft: true, rollup: 'FAILURE', failing: ['build'] }),
  }
  engine(on, gh(prs), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: Object.keys(prs).map(n => ({ pr: `https://github.com/acme/api/pull/${n}` })) })

  const ui = await open($, 'prs')
  const word = async (n: number) => (await ui.find({ key: `state-acme/api#${n}` }))?.text
  expect(await Promise.all([6001, 6002, 6003, 6004, 6005].map(word))).toEqual(['ready', 'CI fail', 'conflict', 'review', 'draft'])
  await ui.unmount()
})

test("someone else's pull request is flagged only for a thread waiting on you, your own for anything", async ($, on) => {
  const prs: Record<number, Pr> = {
    6011: pr({ isDraft: false, rollup: 'FAILURE', failing: ['build'] }),
    6012: pr({ isDraft: false, author: 'rojen', rollup: 'FAILURE', failing: ['build'] }),
    6013: pr({ isDraft: false, author: 'rojen', threads: [{ isResolved: false, by: 'rojen' }] }),
  }
  engine(on, gh(prs), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: Object.keys(prs).map(n => ({ pr: `https://github.com/acme/api/pull/${n}` })) })

  const ui = await open($, 'prs')
  const flagged = async (n: number) => (await ui.find({ key: `flag-acme/api#${n}` }))?.text === '!'
  expect(await Promise.all([6011, 6012, 6013].map(flagged))).toEqual([true, false, true])
  expect(await ui.find({ key: 'prrow-acme/api#6012', text: /CI fail\s*rojen\s*A change$/ })).toBeDefined()
  expect(await ui.find({ key: 'author-acme/api#6011', text: 'octo' })).toBeDefined()
  expect(await ui.find({ key: 'tab-prs', text: 'prs 2' })).toBeDefined()
  await ui.unmount()
})

test('author and repo boxes drop down a checklist, and ticked values narrow the rows', async ($, on) => {
  const prs: Record<number, Pr> = {
    6021: pr({ isDraft: false }),
    6022: pr({ isDraft: false, author: 'rojen' }),
    6023: pr({ isDraft: false, author: 'rojen' }),
  }
  engine(on, gh(prs), NOW)
  await start($)
  await $.tool.call({
    tool: TOOL,
    add: [{ pr: 'https://github.com/acme/api/pull/6021' }, { pr: 'https://github.com/acme/api/pull/6022' }, { pr: 'https://github.com/acme/pay/pull/6023' }],
  })
  const ui = await open($, 'prs')
  const rows = async () => ((await ui.find({ key: 'prs' }))?.text ?? '').match(/#\d{4}/g)

  expect(await ui.find({ key: 'pfilter-author' })).toMatchObject({ props: { label: 'Author: all ▾' } })
  expect(await ui.find({ key: 'pfilter-repo' })).toMatchObject({ props: { label: 'Repo: all ▾' } })
  await ui.press({ key: 'pfilter-author' })
  expect(await ui.find({ key: 'pfopt-author-rojen', text: '☐ rojen 2' })).toBeDefined()
  expect(await ui.find({ key: 'pfilter-popup' })).toMatchObject({ props: { position: 'absolute', top: 2, left: 0 } })
  await ui.press({ key: 'pfopt-author-rojen' })
  expect(await rows()).toEqual(['#6022', '#6023'])
  expect(await ui.find({ key: 'pfilter-author' })).toMatchObject({ props: { label: 'Author: rojen ▴' } })

  await ui.press({ key: 'pfopt-author-octo' })
  expect(await rows()).toEqual(['#6021', '#6022', '#6023'])
  expect(await ui.find({ key: 'pfilter-author' })).toMatchObject({ props: { label: 'Author: 2 picked ▴' } })
  await ui.press({ key: 'pfclear-author' })
  await ui.press({ key: 'pfilter-repo' })
  await ui.press({ key: 'pfopt-repo-pay' })
  expect(await rows()).toEqual(['#6023'])
  await ui.unmount()
})

test('the filter popup folds on a press elsewhere in the pane, or once the pane gives the keyboard back', async ($, on) => {
  engine(on, gh({ 6021: pr({ author: 'octo' }), 6022: pr({ author: 'rojen' }) }), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: 'https://github.com/acme/api/pull/6021' }, { pr: 'https://github.com/acme/api/pull/6022' }] })
  const ui = await open($, 'prs')

  await ui.press({ key: 'pfilter-author' })
  await ui.press({ key: 'pfopt-author-rojen' })
  expect(await ui.find({ key: 'pfilter-popup' })).toBeDefined()
  await ui.press({ key: 'tab-prs' })
  expect(await ui.find({ key: 'pfilter-popup' })).toBeUndefined()
  expect(await ui.find({ key: 'pfilter-author' })).toMatchObject({ props: { label: 'Author: rojen ▾' } })

  await ui.press({ key: 'pfilter-author' })
  await ui.unmount()
  const blurred = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false }, surface: 'terminal' })
  expect(await blurred.find({ key: 'pfilter-popup' })).toBeUndefined()
  await blurred.unmount()
})

test('a refresh says when a tracked pull request merged or its CI failed', async ($, on) => {
  const github = { 6047: pr({}), 6050: pr({ rollup: 'PENDING' }) }
  const w = gh(github)
  const clock = engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }, { pr: TOP }] })

  github[6047] = pr({ state: 'MERGED' })
  github[6050] = pr({ rollup: 'FAILURE', failing: ['unit-test'] })
  await clock.advance(4 * 60_000)
  const read = await $.tool.call({ tool: TOOL })

  expect(String(read.result)).toMatch(/#6047.*\n\s+merged/)
  expect(String(read.result)).toContain('CI failing: unit-test')
  expect(w.toasts).toEqual(['#6047 merged', '#6050 CI failed: unit-test'])

  const ui = await open($, 'prs')
  expect((await ui.find({ key: 'mark-acme/api#6047', text: '◆' }))?.children[0]).toMatchObject({ props: { color: 'merged' } })
  expect(await ui.find({ type: 'Text', text: 'merged' })).toMatchObject({ props: { color: 'merged' } })
  expect(await ui.find({ key: 'mark-acme/api#6050' })).toMatchObject({ text: '' })
  await ui.unmount()
})

test('a change naming a pull request the board does not track is refused whole', async ($, on) => {
  engine(on, gh({ 6047: pr({}) }), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })

  const refused = await $.tool.call({
    tool: TOOL,
    update: [{ pr: BOTTOM, note: 'Ready to mark ready' }],
    remove: ['acme/api#1'],
  })
  expect(refused.deny).toContain('acme/api#1')
  expect(String((await $.tool.call({ tool: TOOL })).result)).not.toContain('Ready to mark ready')
})

test('each session keeps its own pull request board', async ($, on) => {
  const w = gh({ 6047: pr({}) })
  engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })

  w.session.id = 's2'
  expect((await $.tool.call({ tool: TOOL })).result).toBe('No pull requests tracked.')

  w.session.id = 's1'
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('#6047')
})

test('/board prs clear empties the pull request board', async ($, on) => {
  engine(on, gh({ 6047: pr({}) }), NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })

  expect((await board($, 'prs clear')).text).toBe('Pull request board cleared.')
  expect((await $.tool.call({ tool: TOOL })).result).toBe('No pull requests tracked.')
})

test('a refresh asks GitHub in batches, and a batch GitHub fails leaves the others refreshed', async ($, on) => {
  const github: Record<number, Pr> = {}
  for (let n = 1; n <= 10; n++) github[n] = pr({ title: `Change ${n}` })
  const w = gh(github)
  const answer = w.run
  const queries: string[] = []
  w.run = argv => {
    const query = argv[argv.length - 1] ?? ''
    queries.push(query)
    return /pullRequest\(number: 9\)/.test(query) ? { exitCode: 1, stdout: '', stderr: 'gh: HTTP 504' } : answer(argv)
  }
  engine(on, w, NOW)
  await start($)

  const read = String(
    (await $.tool.call({ tool: TOOL, add: Array.from({ length: 10 }, (_, at) => ({ pr: `acme/api#${at + 1}` })) })).result,
  )
  expect(queries.length).toBe(2)
  expect(read).toContain('GitHub check failed: gh: HTTP 504, 2 of 10 pull requests not refreshed')
  expect(read).toContain('acme/api#1 Change 1')
  expect(read).toContain('acme/api#8 Change 8')
  expect(read).not.toContain('Change 9')
})

test('a merged pull request is not asked about again', async ($, on) => {
  const github = { 6047: pr({ state: 'MERGED' }), 6050: pr({}) }
  const w = gh(github)
  const answer = w.run
  const queries: string[] = []
  w.run = argv => {
    queries.push(argv[argv.length - 1] ?? '')
    return answer(argv)
  }
  const clock = engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }, { pr: TOP }] })

  queries.length = 0
  await clock.advance(4 * 60_000)
  const read = String((await $.tool.call({ tool: TOOL })).result)
  expect(queries.join('\n')).not.toContain('number: 6047')
  expect(queries.join('\n')).toContain('number: 6050')
  expect(read).toMatch(/#6047.*\n\s+merged/)
})

test('a pull request merged long ago leaves the GitHub stamp at the time the open ones were checked', async ($, on) => {
  const w = gh({ 6047: pr({ state: 'MERGED' }), 6050: pr({}) })
  const clock = engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }, { pr: TOP }] })

  await clock.advance(18 * 3600_000)
  await $.tool.call({ tool: TOOL })
  const ui = await open($, 'prs')
  expect(await ui.find({ key: 'stamp', text: 'GitHub checked just now' })).toBeDefined()
  await ui.unmount()
})

/** Records every query gh is asked, answering from `github`. */
function recording(github: Record<number, Pr>, budget?: { remaining: number; resetAt: string }) {
  const w = gh(github, budget)
  const answer = w.run
  const queries: string[] = []
  w.run = argv => {
    if (argv[0] === 'gh') queries.push(argv[argv.length - 1] ?? '')
    return answer(argv)
  }

  return { w, queries }
}

test('a pull request another session fetched moments ago is read from the shared cache, not asked again', async ($, on) => {
  const { w, queries } = recording({ 6047: pr({ title: 'Fee lookup' }) })
  engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })
  expect(queries.length).toBe(1)

  w.session.id = 's2'
  const read = String((await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })).result)
  expect(queries.length).toBe(1)
  expect(read).toContain('acme/api#6047 Fee lookup')
})

test('while the rate limit runs low no session asks GitHub, and the board says when it will again', async ($, on) => {
  const resetAt = new Date(NOW + 20 * 60_000).toISOString()
  const { w, queries } = recording({ 6047: pr({}) }, { remaining: 500, resetAt })
  const clock = engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })
  expect(queries.length).toBe(1)

  await clock.advance(4 * 60_000)
  w.session.id = 's2'
  const read = String((await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })).result)
  expect(queries.length).toBe(1)
  expect(read).toContain('GitHub check failed: rate limit low, retrying in 16m')
})

test('a rate limit error pauses every session for ten minutes', async ($, on) => {
  const { w, queries } = recording({ 6047: pr({}) })
  const answer = w.run
  let limited = true
  w.run = argv => {
    if (limited && argv[0] === 'gh') {
      queries.push('limited')
      return { exitCode: 1, stdout: '', stderr: 'gh: API rate limit already exceeded for user ID 1.' }
    }
    return answer(argv)
  }
  const clock = engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })
  limited = false

  await clock.advance(5 * 60_000)
  expect(queries).toEqual(['limited'])
  await clock.advance(6 * 60_000)
  expect(queries.length).toBeGreaterThan(1)
})

test('a session nobody has used for half an hour stops asking GitHub until the next turn', async ($, on) => {
  const { w, queries } = recording({ 6047: pr({}) })
  const clock = engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })

  await clock.advance(31 * 60_000)
  const asked = queries.length
  await clock.advance(20 * 60_000)
  expect(queries.length).toBe(asked)

  await $.turn.start({ text: 'where do the pull requests stand?', turnId: 't1' })
  await clock.advance(4 * 60_000)
  expect(queries.length).toBeGreaterThan(asked)
})
