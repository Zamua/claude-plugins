import { expect, test } from 'claude-code/testing'

import { board, engine, open, start, world } from './engine'

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
    author: { login: 'octo' },
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
    latestReviews: { nodes: [] },
  }
}

/** A world whose gh answers GitHub's GraphQL from `github`, keyed by pull request number. */
function gh(github: Record<number, Pr>) {
  return world({
    run: argv => {
      if (argv[0] !== 'gh') return undefined
      const query = argv[argv.length - 1] ?? ''
      const data: Record<string, unknown> = { viewer: { login: 'octo' } }
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
    expect(await ui.find({ type: 'Text', text: 'GitHub checked just now' })).toBeDefined()
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

test('a refresh says when a tracked pull request merged or its CI failed', async ($, on) => {
  const github = { 6047: pr({}), 6050: pr({ rollup: 'PENDING' }) }
  const w = gh(github)
  engine(on, w, NOW)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }, { pr: TOP }] })

  github[6047] = pr({ state: 'MERGED' })
  github[6050] = pr({ rollup: 'FAILURE', failing: ['unit-test'] })
  const read = await $.tool.call({ tool: TOOL })

  expect(String(read.result)).toMatch(/#6047.*\n\s+merged/)
  expect(String(read.result)).toContain('CI failing: unit-test')
  expect(w.toasts).toEqual(['#6047 merged', '#6050 CI failed: unit-test'])
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
