import type { EngineInterface } from 'claude-code'

import { messageOf } from '../../kit'
import type { HostSession, HostStart, SessionState } from '../model'

type Pane = {
  pane_id: string
  workspace_id: string
  agent?: string
  agent_status?: string
  agent_session?: { value?: string }
}
type Workspace = { workspace_id: string; label: string }
type Created = { result: { root_pane: { pane_id: string; workspace_id: string } } }

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
      const labels = new Map(workspaces.map(w => [w.workspace_id, w.label]))
      for (const pane of panes) {
        if (!pane.agent) continue
        sessions.push({
          address: `${name}/${pane.pane_id}`,
          label: labels.get(pane.workspace_id) ?? pane.workspace_id,
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
  const { session, workspace } = partsOf(address)
  try {
    await herdr($, session, ['workspace', 'focus', workspace])

    return undefined
  } catch (err) {
    return `herdr could not open it: ${messageOf(err)}`
  }
}

/** A new workspace beside the starting session, an agent in its first pane, then the brief as its first prompt. */
export async function startHerdr($: EngineInterface, start: HostStart): Promise<{ address?: string; error?: string }> {
  const session = start.near ? partsOf(start.near).session : 'default'
  try {
    const created = JSON.parse(
      await herdr($, session, ['workspace', 'create', '--cwd', start.cwd, '--label', start.label, '--no-focus']),
    ) as Created
    const pane = created.result.root_pane.pane_id
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
