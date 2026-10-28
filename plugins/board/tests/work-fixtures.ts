import { CONFIG_FILE, HOME, json, world } from './engine'
import type { World } from './engine'

export const WORK_FILE = `${HOME}/work.json`
export const WORK_CONFIG = { boards: [{ id: 'work', layout: 'model', path: '~/work.json' }] }

export const TREE = {
  version: 2,
  updated_at: '2026-10-27T13:55:00Z',
  next_ref: 10,
  items: [
    { id: 'pay', title: 'Payments rework', kind: 'Project', status: 'flight' },
    { id: 'gross', title: 'Gross funding', kind: 'Workstream', parent: 'pay', status: 'flight' },
    { id: 'fee', ref: 3, title: 'Settle the fee account', kind: 'Task', parent: 'gross', status: 'needs' },
    { id: 'scope', ref: 4, title: 'Scope the split', kind: 'Task', parent: 'pay', status: 'flight', detail: 'Against **main**.' },
    { id: 'old', title: 'Old launch', kind: 'Project', status: 'flight' },
    { id: 'old-task', ref: 5, title: 'Shipped it', kind: 'Task', parent: 'old', status: 'done' },
    { id: 'tooling', title: 'Tooling', kind: 'Responsibility', shape: 'responsibility', status: 'flight' },
    { id: 'hostit', ref: 6, title: 'hostit site list', kind: 'Project', parent: 'tooling', status: 'next' },
  ],
  links: [],
}

export const withTree = (file: unknown = TREE) =>
  world({ files: { [CONFIG_FILE]: json(WORK_CONFIG), [WORK_FILE]: json(file) } })

export const LIVE_CONFIG = {
  boards: [
    {
      id: 'work',
      layout: 'model',
      path: '~/work.json',
      sources: { github: {} },
      hosts: { herdr: {} },
      harnesses: { claude: { args: ['--model', 'opus'] } },
    },
  ],
}

/**
 * A pane herdr lists: `agent: ''` is a shell with no agent in it. `label` is its workspace's, and `tab` names the tab
 * it sits in, which is its workspace's first, unnamed, when left out.
 */
export type HerdrPane = {
  id: string
  label: string
  status?: string
  harnessId?: string
  agent?: string
  tab?: { id: string; label: string }
}

const ran = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
const workspaceOf = (pane: string) => pane.split(':')[0] ?? pane
const tabOf = (p: HerdrPane) => p.tab ?? { id: `${workspaceOf(p.id)}:t1`, label: '1' }

/** herdr with one running session, named `session`, holding `panes`; creating a workspace or tab adds `created`. */
export function herdrHost(panes: HerdrPane[], created?: HerdrPane, session = 'default') {
  let all = panes

  return (argv: readonly string[]) => {
    if (argv[0] !== 'herdr') return undefined
    const args = argv.slice(argv[1] === '--session' ? 3 : 1).join(' ')
    if (args === 'session list') {
      return ran(`name     status   directory  socket\n${session}  running  /h/a  /h/a.sock\nold      stopped  /h/old      /h/old.sock\n`)
    }
    if (args === 'pane list') {
      const listed = all.map(p => ({
        pane_id: p.id,
        workspace_id: workspaceOf(p.id),
        tab_id: tabOf(p).id,
        ...(p.agent !== '' && { agent: p.agent ?? 'claude' }),
        agent_status: p.status ?? 'idle',
        ...(p.harnessId && { agent_session: { value: p.harnessId } }),
      }))
      return ran(json({ result: { panes: listed } }))
    }
    if (args === 'workspace list') {
      return ran(json({ result: { workspaces: all.map(p => ({ workspace_id: workspaceOf(p.id), label: p.label })) } }))
    }
    if (args === 'tab list') {
      const tabs = [...new Map(all.map(p => [tabOf(p).id, tabOf(p)])).values()]
      return ran(json({ result: { tabs: tabs.map(t => ({ tab_id: t.id, label: t.label, number: Number(t.id.split(':t')[1]) })) } }))
    }
    if (args.startsWith('pane get ')) {
      const pane = all.find(p => p.id === args.slice('pane get '.length))
      return ran(json({ result: { pane: pane ? { pane_id: pane.id, tab_id: tabOf(pane).id } : {} } }))
    }
    if ((args.startsWith('workspace create') || args.startsWith('tab create')) && created) {
      all = [...all, created]
      return ran(json({ result: { root_pane: { pane_id: created.id }, tab: { tab_id: tabOf(created).id } } }))
    }
    if (args.startsWith('tab rename ')) {
      const [, , id = '', ...label] = args.split(' ')
      all = all.map(p => (tabOf(p).id === id ? { ...p, tab: { id, label: label.join(' ') } } : p))
      return ran('')
    }

    return ran('')
  }
}

/** Claude Code's record of a running agent, as its harness id and message name. */
export const sessionRecord = (pid: number, sessionId: string, name: string, updatedAt: number) => ({
  [`${HOME}/.claude/sessions/${pid}.json`]: json({ sessionId, name, updatedAt }),
})

/** The board plugin's store file as other sessions left it. */
export const storeFile = (held: Record<string, unknown>) => ({ [`${HOME}/.claude/plugins/store/board_test.json`]: json(held) })

export const sessionBoard = (sessionId: string, goal: string, summary: string) => ({
  [`session:${sessionId}`]: { shape: 'session-1', value: { sessionId, goal, summary, items: [], seq: 0 } },
})

export const prsBoard = (sessionId: string, prs: unknown[]) => ({
  [`prs:${sessionId}`]: { shape: 'prs-1', value: { sessionId, prs, viewer: 'me', checkedAt: 0, error: '' } },
})

export const trackedPr = (number: number, title: string, over: Record<string, unknown> = {}) => ({
  key: `acme/api#${number}`,
  owner: 'acme',
  repo: 'api',
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  note: '',
  stack: '',
  facts: {
    title,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    review: 'REVIEW_REQUIRED',
    approvedBy: [],
    changesRequestedBy: [],
    ci: 'pass',
    failing: [],
    author: 'me',
    head: 'feature/x',
    base: 'main',
    headSha: 'abc',
    waiting: 0,
    ...over,
  },
})

export function withLive(file: unknown, run: World['run'], files: Record<string, string> = {}) {
  return world({ files: { [CONFIG_FILE]: json(LIVE_CONFIG), [WORK_FILE]: json(file), ...files }, run })
}
