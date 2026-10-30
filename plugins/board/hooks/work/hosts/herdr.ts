import type { EngineInterface } from 'claude-code'

import { messageOf } from '../../kit'
import type { HostSession, HostStart, SessionState } from '../model'

type Pane = {
  pane_id: string
  workspace_id: string
  tab_id?: string
  agent?: string
  agent_status?: string
  agent_session?: { value?: string }
}
type Workspace = { workspace_id: string; label: string }
type Tab = { tab_id: string; label: string; number: number }
type Created = { result: { root_pane: { pane_id: string }; tab?: { tab_id: string } } }

/** `hosts.herdr` in boards.json. */
export type HerdrConfig = {
  /** The herdr session started sessions run in, over the starting session's own. */
  session?: string
  /**
   * The workspace an Item's sessions start in, each as a tab, by Item id. An Item's nearest ancestor that names one
   * decides; an Item none names starts its sessions in a workspace of their own.
   */
  workspaces?: Record<string, string>
}

const STATES: Record<string, SessionState> = { working: 'working', blocked: 'waiting', done: 'done', idle: 'idle' }
const START_TIMEOUT_MS = 60_000

/** An address is `<herdr session>/<pane id>`, and a pane id starts with its workspace's id. */
const partsOf = (address: string) => {
  const [session = '', pane = ''] = address.split('/')

  return { session, pane, workspace: pane.split(':')[0] ?? '' }
}

async function herdr($: EngineInterface, session: string, args: string[], timeoutMs?: number) {
  const ran = await $.process.run(['herdr', '--session', session, ...args], timeoutMs ? { timeoutMs } : undefined)
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n')[0] || `herdr ${args.join(' ')} exited ${ran.exitCode}`)

  return ran.stdout
}

/** Every running herdr session's panes that hold an agent, labeled by their workspace. */
export async function listHerdr($: EngineInterface): Promise<{ sessions: HostSession[]; error?: string }> {
  try {
    const listed = await $.process.run(['herdr', 'session', 'list'])
    const names = listed.stdout
      .split('\n')
      .slice(1)
      .map(line => line.trim().split(/\s+/))
      .filter(([name, status]) => name && status === 'running')
      .map(([name]) => name as string)
    const sessions: HostSession[] = []
    for (const name of names) {
      const panes = (JSON.parse(await herdr($, name, ['pane', 'list'])) as { result: { panes: Pane[] } }).result.panes
      const workspaces = (JSON.parse(await herdr($, name, ['workspace', 'list'])) as { result: { workspaces: Workspace[] } })
        .result.workspaces
      const tabs = (JSON.parse(await herdr($, name, ['tab', 'list'])) as { result: { tabs: Tab[] } }).result.tabs
      const labels = new Map(workspaces.map(w => [w.workspace_id, w.label]))
      // herdr labels a tab with its number until someone names it
      const named = new Map(tabs.filter(tab => tab.label !== String(tab.number)).map(tab => [tab.tab_id, tab.label]))
      for (const pane of panes) {
        if (!pane.agent) continue
        sessions.push({
          address: `${name}/${pane.pane_id}`,
          label: named.get(pane.tab_id ?? '') ?? labels.get(pane.workspace_id) ?? pane.workspace_id,
          group: name,
          state: STATES[pane.agent_status ?? ''] ?? 'idle',
          harness: pane.agent,
          ...(pane.agent_session?.value && { harnessId: pane.agent_session.value }),
        })
      }
    }

    return { sessions }
  } catch (err) {
    return { sessions: [], error: `herdr: ${messageOf(err)}` }
  }
}

export async function focusHerdr($: EngineInterface, address: string): Promise<string | undefined> {
  const { session, pane, workspace } = partsOf(address)
  try {
    await herdr($, session, ['workspace', 'focus', workspace])
    const tab = (JSON.parse(await herdr($, session, ['pane', 'get', pane])) as { result: { pane: Pane } }).result.pane.tab_id
    if (tab) await herdr($, session, ['tab', 'focus', tab])

    return undefined
  } catch (err) {
    return `herdr could not open it: ${messageOf(err)}`
  }
}

/**
 * A tab in the workspace the Item's branch names, made if missing, else one beside the session that started it, else a
 * workspace of its own; then an agent in its first pane, and the brief as its first prompt.
 */
export async function startHerdr(
  $: EngineInterface,
  start: HostStart,
  config: HerdrConfig = {},
): Promise<{ address?: string; error?: string }> {
  const session = config.session ?? (start.near ? partsOf(start.near).session : 'default')
  const area = start.within.map(id => config.workspaces?.[id]).find(Boolean)
  const env = Object.entries(start.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`])
  const opened = (out: string) => (JSON.parse(out) as Created).result
  try {
    const workspaces = area
      ? (JSON.parse(await herdr($, session, ['workspace', 'list'])) as { result: { workspaces: Workspace[] } }).result.workspaces
      : []
    const beside = !area && start.beside && partsOf(start.beside).session === session ? partsOf(start.beside).workspace : undefined
    const holder = workspaces.find(one => one.label === area)?.workspace_id ?? beside
    let pane: string
    if (holder) {
      const args = ['tab', 'create', '--workspace', holder, '--cwd', start.cwd, '--label', start.label, '--no-focus']
      pane = opened(await herdr($, session, [...args, ...env])).root_pane.pane_id
    } else {
      const args = ['workspace', 'create', '--cwd', start.cwd, '--label', area ?? start.label, '--no-focus']
      const created = opened(await herdr($, session, [...args, ...env]))
      pane = created.root_pane.pane_id
      if (area && created.tab) await herdr($, session, ['tab', 'rename', created.tab.tab_id, start.label])
    }
    await herdr(
      $,
      session,
      ['agent', 'start', start.label, '--kind', start.harness, '--pane', pane, '--timeout', String(START_TIMEOUT_MS), '--', ...start.args],
      START_TIMEOUT_MS + 10_000,
    )
    await herdr($, session, ['agent', 'prompt', start.label, start.brief])

    return { address: `${session}/${pane}` }
  } catch (err) {
    return { error: `herdr could not start ${start.label}: ${messageOf(err)}` }
  }
}

type WorkspaceList = { result: { workspaces: { label: string; workspace_id: string }[] } }

/** Raises the workspace a label or id names in herdr's current session; the text says why when it could not. */
export async function focusWorkspace($: EngineInterface, label: string): Promise<string | undefined> {
  try {
    const listed = await $.process.run(['herdr', 'workspace', 'list'])
    const workspaces = (JSON.parse(listed.stdout) as WorkspaceList).result.workspaces
    const match = workspaces.find(w => w.label === label || w.workspace_id === label)
    if (!match) return `No herdr workspace named ${label}.`
    const focused = await $.process.run(['herdr', 'workspace', 'focus', match.workspace_id])

    return focused.exitCode === 0 ? undefined : `herdr could not open ${label}.`
  } catch (err) {
    return `herdr failed: ${messageOf(err)}`
  }
}
