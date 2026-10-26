import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const TOOL = 'mcp__my-pr-board__prs'
const NOW = Date.parse('2026-10-25T12:00:00Z')
const BOTTOM = 'https://github.com/joinmason/cherry-pos/pull/6047'
const TOP = 'https://github.com/joinmason/cherry-pos/pull/6050'

const PANE = {
  plugin: 'my-pr-board',
  component: 'Pane',
  requestId: 'my-pr-board',
  props: {
    title: 'My PRs',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

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
    author: { login: 'Zamua' },
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

/** Answers gh's GraphQL call from `github`, keyed by pull request number. */
function engine(on: On, session: { id: string }, github: Record<number, Pr>, toasts: string[] = []) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.id', () => ({ value: session.id }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'myprs' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const query = e.argv[e.argv.length - 1] ?? ''
    const data: Record<string, unknown> = { viewer: { login: 'Zamua' } }
    for (const [, alias, number] of query.matchAll(/(p\d+): repository\([^)]*\) \{ pullRequest\(number: (\d+)\)/g)) {
      const found = github[Number(number)]
      data[alias as string] = { pullRequest: found ? asGraphql(found) : null }
    }
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ data }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('a pull request opened with gh pr create joins the board with its GitHub state', async ($, on) => {
  engine(on, { id: 's1' }, {
    6050: pr({
      title: 'MM-819 nets the held reserve',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      threads: [
        { isResolved: true, by: 'Zamua' },
        { isResolved: false, by: 'cursor' },
        { isResolved: false, by: 'Zamua' },
      ],
    }),
  })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: `${TOP}\n`, stderr: '', interrupted: false },
    text: `${TOP}\n`,
  }))
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --title x' })
  expect(ran.context?.join('\n')).toContain('now tracks joinmason/cherry-pos#6050')
  await $.tool.call({ tool: TOOL })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /MM-819 nets the held reserve/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 needs you$/ })).toBeDefined()
    const needs = await ui.find({ key: 'needs' })
    expect(needs?.text).toContain('conflicts with its base, so its green CI is stale')
    expect(needs?.text).toContain('1 review thread waiting on you')
    await ui.unmount()
  }
})

test('a pull request based on another tracked one sits above it in one stack', async ($, on) => {
  engine(on, { id: 's1' }, {
    6047: pr({ title: 'MM-818 fee lookup', headRefName: 'feature/mm-818' }),
    6050: pr({ title: 'MM-819 reserve netting', headRefName: 'feature/mm-819', baseRefName: 'feature/mm-818' }),
  })
  await start($)

  const read = await $.tool.call({
    tool: TOOL,
    add: [{ pr: TOP, note: 'Rebase onto main' }, { pr: 'joinmason/cherry-pos#6047' }],
  })
  const text = String(read.result)
  expect(text.indexOf('#6047')).toBeLessThan(text.indexOf('#6050'))
  expect(text).toContain('on #6047')
  expect(text).toContain('note: Rebase onto main')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Stack$/ })).toBeDefined()
  const rows = (await ui.find({ key: 'prs' }))?.text ?? ''
  expect(rows.indexOf('#6047')).toBeLessThan(rows.indexOf('#6050'))
  expect((await ui.find({ key: 'next' }))?.text).toContain('Rebase onto main')
  await ui.unmount()
})

test('a refresh says when a tracked pull request merged or its CI failed', async ($, on) => {
  const toasts: string[] = []
  const github = {
    6047: pr({}),
    6050: pr({ rollup: 'PENDING' }),
  }
  engine(on, { id: 's1' }, github, toasts)
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }, { pr: TOP }] })

  github[6047] = pr({ state: 'MERGED' })
  github[6050] = pr({ rollup: 'FAILURE', failing: ['unit-test'] })
  const read = await $.tool.call({ tool: TOOL })

  expect(String(read.result)).toMatch(/#6047.*\n\s+merged/)
  expect(String(read.result)).toContain('CI failing: unit-test')
  expect(toasts).toEqual(['#6047 merged', '#6050 CI failed: unit-test'])
})

test('a change naming a pull request the board does not track is refused whole', async ($, on) => {
  engine(on, { id: 's1' }, { 6047: pr({}) })
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })

  const refused = await $.tool.call({
    tool: TOOL,
    update: [{ pr: BOTTOM, note: 'Ready to mark ready' }],
    remove: ['joinmason/cherry-pos#1'],
  })
  expect(refused.deny).toContain('joinmason/cherry-pos#1')
  expect(String((await $.tool.call({ tool: TOOL })).result)).not.toContain('Ready to mark ready')
})

test('each session keeps its own board', async ($, on) => {
  const session = { id: 's1' }
  engine(on, session, { 6047: pr({}) })
  await start($)
  await $.tool.call({ tool: TOOL, add: [{ pr: BOTTOM }] })

  session.id = 's2'
  expect((await $.tool.call({ tool: TOOL })).result).toBe('No pull requests tracked.')

  session.id = 's1'
  expect(String((await $.tool.call({ tool: TOOL })).result)).toContain('#6047')
})
