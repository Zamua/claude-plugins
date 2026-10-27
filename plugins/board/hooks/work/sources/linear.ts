import type { EngineInterface } from 'claude-code'

import { qualify } from '../model'
import type { Item, SourceAnswer, Status } from '../model'

export const LINEAR_FRESH_MS = 10 * 60_000

type Followed = { name: string; under?: string }
export type LinearConfig = { team?: string; projects?: Followed[]; kinds?: { project?: string; issue?: string } }

type State = { name?: string; type?: string }
type Issue = {
  identifier: string
  title: string
  url?: string
  state?: State
  assignee?: { name?: string } | null
  parent?: { identifier?: string } | null
  dueDate?: string | null
  project?: { id?: string; name?: string } | null
}

/** Linear's state types on the one scale; a started issue named "In Review" waits on its reviewers. */
function statusOf(state: State | undefined): Status {
  const type = state?.type ?? ''
  if (type === 'completed' || type === 'canceled') return 'done'
  if (type === 'started') return /review/i.test(state?.name ?? '') ? 'waiting' : 'flight'

  return 'next'
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

function issueItem(issue: Issue, projectId: string, kind: string): Item {
  const parent = issue.parent?.identifier ? `linear:${issue.parent.identifier}` : projectId

  return {
    id: `linear:${issue.identifier}`,
    source: 'linear',
    kind,
    title: issue.title,
    ...(issue.url && { url: issue.url }),
    shape: 'outcome',
    status: statusOf(issue.state),
    isStatusLive: true,
    parent,
    aliases: [issue.identifier],
    ...(issue.dueDate && { target: issue.dueDate }),
    ...(issue.assignee?.name && { owner: issue.assignee.name }),
    links: issue.url ? [{ label: 'Linear', url: issue.url }] : [],
  }
}

/**
 * Each followed project as an Item, under the Item its `under` names, with its issues beneath it, through the
 * `linear` CLI, which signs in as the person. A project's status is that of its open issues as they roll up.
 */
export async function readLinear($: EngineInterface, config: LinearConfig): Promise<SourceAnswer> {
  const team = config.team ?? ''
  const items: Item[] = []
  for (const followed of config.projects ?? []) {
    const ran = await $.process.run(
      [
        'linear',
        'issue',
        'list',
        ...(team ? ['--team', team] : []),
        '--project',
        followed.name,
        '--all-states',
        '--all-assignees',
        '--limit',
        'all',
        '--json',
        '--no-input',
      ],
      { timeoutMs: 30_000 },
    )
    if (ran.exitCode !== 0) {
      return { error: `Linear: ${ran.stderr.trim().split('\n')[0] || `exited ${ran.exitCode}`}` }
    }
    const issues = JSON.parse(ran.stdout) as Issue[]
    const projectId = `linear:project:${slugOf(followed.name)}`
    const open = issues.some(issue => statusOf(issue.state) !== 'done')
    items.push({
      id: projectId,
      source: 'linear',
      kind: config.kinds?.project ?? 'Project',
      title: followed.name,
      shape: 'outcome',
      status: open ? 'flight' : 'done',
      ...(followed.under && { parent: qualify(followed.under) }),
      aliases: [],
      links: [],
    })
    for (const issue of issues) items.push(issueItem(issue, projectId, config.kinds?.issue ?? 'Task'))
  }

  return { items }
}
