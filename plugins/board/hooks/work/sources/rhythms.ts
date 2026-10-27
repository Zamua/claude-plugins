import type { EngineInterface, On } from 'claude-code'

import type { Item, SourceAnswer, Status } from '../model'

export const RHYTHMS_FRESH_MS = 60 * 60_000

const SEARCH = 'mcp__rhythms__search_knowledge'
const GET = 'mcp__rhythms__get_goal'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RhythmsConfig = { follow?: string[]; kinds?: Record<string, string> }

type Goal = {
  uuid: string
  short_id: string
  title: string
  type?: string
  url?: string
  current_status?: string
  progress?: number | null
  parent_uuids?: string[]
  owner_names?: string[]
  current_user_roles?: string[]
  last_checkin_date?: string | null
  start_date?: string | null
  end_date?: string | null
  latest_checkin?: { note?: string; checkin_date?: string } | null
}
type Search = { data?: { records?: Goal[]; children?: Goal[] } }

const LEVELS: Record<string, string> = {
  'Okrs::Objective': 'objective',
  'Okrs::KeyResult': 'key_result',
  'Okrs::Initiative': 'initiative',
}
const NAMES: Record<string, string> = { objective: 'Objective', key_result: 'Key result', initiative: 'Initiative' }

/** Rhythms' goal states on the one scale; a goal the person owns whose weekly check-in is unposted needs them. */
function statusOf(goal: Goal, now: number): Status {
  const status = goal.current_status ?? ''
  if (status === 'closed') return 'done'
  if (goal.current_user_roles?.includes('owner') && isCheckinDue(goal.last_checkin_date, now)) return 'needs'
  if (status === 'not_started') return 'next'
  if (status === 'postponed') return 'waiting'

  return 'flight'
}

// Check-ins fall due each Monday, so one posted before the latest Monday is overdue
function isCheckinDue(last: string | null | undefined, now: number) {
  const monday = new Date(now)
  monday.setUTCHours(0, 0, 0, 0)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))

  return !last || Date.parse(last) < monday.getTime()
}

/** A tool's answer as the model reads it: its text blocks joined, or the result itself. */
function answerOf(called: { result?: unknown; text?: string; deny?: string }): unknown {
  if (called.deny) throw new Error(called.deny)
  const raw = called.text ?? (typeof called.result === 'string' ? called.result : JSON.stringify(called.result))

  return JSON.parse(raw)
}

/**
 * The followed goals and their direct children, through the Rhythms MCP server the person connected, in one search.
 * A followed goal named by short id, such as OBJ-2228, is looked up first.
 */
export async function readRhythms($: EngineInterface, config: RhythmsConfig): Promise<SourceAnswer> {
  const uuids: string[] = []
  for (const goal of config.follow ?? []) {
    if (UUID.test(goal)) {
      uuids.push(goal)
      continue
    }
    const got = answerOf(await $.tool.call({ tool: GET, goal_uuid: goal })) as { data?: { record?: { uuid?: string } } }
    const uuid = got.data?.record?.uuid
    if (!uuid) return { error: `Rhythms has no goal ${goal}.` }
    uuids.push(uuid)
  }
  if (uuids.length === 0) return { items: [] }
  const found = answerOf(
    await $.tool.call({ tool: SEARCH, type: 'goal', goal_uuids: uuids, include_children: true, children_limit: 50, detail: 'detail' }),
  ) as Search
  const goals = [...(found.data?.records ?? []), ...(found.data?.children ?? [])]
  const shortOf = new Map(goals.map(goal => [goal.uuid, goal.short_id]))
  const now = await $.clock.now()
  const items = goals.map((goal): Item => {
    const level = LEVELS[goal.type ?? ''] ?? 'goal'
    const parent = (goal.parent_uuids ?? []).map(uuid => shortOf.get(uuid)).find(Boolean)
    const note = goal.latest_checkin?.note?.trim()

    return {
      id: `rhythms:${goal.short_id}`,
      source: 'rhythms',
      kind: config.kinds?.[level] ?? NAMES[level] ?? 'Goal',
      title: goal.title,
      ...(goal.url && { url: goal.url }),
      shape: 'outcome',
      status: statusOf(goal, now),
      isStatusLive: true,
      ...(parent && { parent: `rhythms:${parent}` }),
      aliases: [goal.short_id],
      ...(typeof goal.progress === 'number' && { progress: goal.progress }),
      ...(goal.start_date && { started: goal.start_date }),
      ...(goal.end_date && { target: goal.end_date }),
      ...(goal.owner_names?.[0] && { owner: goal.owner_names[0] }),
      ...(note && { detail: `${note}\n\n${goal.latest_checkin?.checkin_date ?? ''} check-in` }),
      links: goal.url ? [{ label: 'Rhythms', url: goal.url }] : [],
    }
  })

  return { items }
}

/** The board's own reads of Rhythms run unasked; every other call to those tools goes to the usual check. */
export function rhythmsHooks(on: On) {
  on('tool.check', { tool: SEARCH }, ($, e, next) => (next.origin.plugin === 'board' ? { decision: 'allow' as const } : next(e)))
  on('tool.check', { tool: GET }, ($, e, next) => (next.origin.plugin === 'board' ? { decision: 'allow' as const } : next(e)))
}
