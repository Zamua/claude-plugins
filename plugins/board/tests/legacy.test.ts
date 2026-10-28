import { expect, test } from 'claude-code/testing'

import { engine, HOME, json, start, world } from './engine'

const NOW = Date.parse('2026-10-26T15:00:00Z')
const STORE = `${HOME}/.claude/plugins/store`
const SESSION_TOOL = 'mcp__board__session'
const PRS_TOOL = 'mcp__board__prs'

const oldSession = (items: { id: string; section: string; text: string; url?: string; isDone?: boolean }[], goal = 'Old goal') => ({
  shape: 'board-1',
  value: { sessionId: 's1', goal, summary: 'Old summary', items, seq: items.length },
})

const tracked = (n: number, note = '') => ({
  key: `acme/api#${n}`,
  owner: 'acme',
  repo: 'api',
  number: n,
  url: `https://github.com/acme/api/pull/${n}`,
  note,
  stack: '',
})

const gh = () => ({ exitCode: 1, stdout: '', stderr: 'offline' })

test('a session whose old session-board board is in its store file gets it back whole, ids and all', async ($, on) => {
  const w = world({
    files: {
      [`${STORE}/session-board_example-abc.json`]: json({
        'board:s1': oldSession([
          { id: 'n1', section: 'next', text: 'Run tests' },
          { id: 'q2', section: 'questions', text: 'Backfill?', isDone: true },
        ]),
        'board:s2': oldSession([{ id: 'n1', section: 'next', text: 'Someone else' }]),
      }),
    },
  })
  engine(on, w, NOW)
  await start($)

  const read = String((await $.tool.call({ tool: SESSION_TOOL })).result)
  expect(read).toContain('goal: Old goal')
  expect(read).toContain('n1 Run tests')
  expect(read).toContain('q2 [done] Backfill?')
  expect(read).not.toContain('Someone else')
})

test('a board rebuilt since keeps its items and takes in only the old ones it lacks, under fresh ids', async ($, on) => {
  const w = world({
    store: {
      'session:s1': {
        shape: 'session-1',
        value: {
          sessionId: 's1',
          goal: 'New goal',
          summary: '',
          items: [{ id: 'n1', section: 'next', text: 'Run tests' }],
          seq: 1,
        },
      },
    },
    files: {
      [`${STORE}/session-board_example-abc.json`]: json({
        'board:s1': oldSession([
          { id: 'n1', section: 'next', text: 'run tests ' },
          { id: 'd2', section: 'decisions', text: 'Use the reader endpoint' },
        ]),
      }),
    },
  })
  engine(on, w, NOW)
  await start($)

  const read = String((await $.tool.call({ tool: SESSION_TOOL })).result)
  expect(read).toContain('goal: New goal')
  expect(read).toContain('summary: Old summary')
  expect(read.match(/run tests/gi)?.length).toBe(1)
  expect(read).toContain('d2 Use the reader endpoint')
})

test('the old board is taken in once, so an item removed afterwards stays removed', async ($, on) => {
  const w = world({
    files: {
      [`${STORE}/session-board_example-abc.json`]: json({
        'board:s1': oldSession([{ id: 'n1', section: 'next', text: 'Run tests' }]),
      }),
    },
  })
  engine(on, w, NOW)
  await start($)

  await $.tool.call({ tool: SESSION_TOOL, remove: ['n1'] })
  await start($)
  expect(String((await $.tool.call({ tool: SESSION_TOOL })).result)).not.toContain('Run tests')
})

test('a session with no old board starts empty, and nothing is read from a missing store folder', async ($, on) => {
  engine(on, world(), NOW)
  await start($)

  expect((await $.tool.call({ tool: SESSION_TOOL })).result).toContain('goal: (none)')
})

test('pull requests the old my-pr-board board tracked join the board, and a note it had fills an empty one', async ($, on) => {
  const w = world({
    run: gh,
    store: {
      'prs:s1': {
        shape: 'prs-1',
        value: { sessionId: 's1', prs: [tracked(1)], viewer: '', checkedAt: 0, error: '' },
      },
    },
    files: {
      [`${STORE}/my-pr-board_example-def.json`]: json({
        'board:s1': {
          shape: 'prs-1',
          value: { sessionId: 's1', prs: [tracked(1, 'Rebase first'), tracked(2, 'Waiting on CI')], viewer: 'octo', checkedAt: 0, error: '' },
        },
      }),
    },
  })
  engine(on, w, NOW)
  await start($)

  const read = String((await $.tool.call({ tool: PRS_TOOL })).result)
  expect(read).toContain('acme/api#1')
  expect(read).toContain('note: Rebase first')
  expect(read).toContain('acme/api#2')
  expect(read).toContain('note: Waiting on CI')
})
