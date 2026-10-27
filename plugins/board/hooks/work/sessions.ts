import type { EngineInterface } from 'claude-code'

import { messageOf } from '../kit'
import { storedValues } from '../store'
import { storedSessionBoard } from '../views/session'
import { readSource } from './cache'
import { claudeArgs, claudeInfo } from './harnesses/claude'
import type { HarnessInfo } from './harnesses/claude'
import { focusHerdr, listHerdr, startHerdr } from './hosts/herdr'
import type { Artifact, HostSession, HostStart, Item, Session, SourceAnswer } from './model'
import { readBoards } from './sources/boards'
import { readArtifacts } from './sources/github'
import { LINEAR_FRESH_MS, readLinear } from './sources/linear'
import type { LinearConfig } from './sources/linear'
import { readRhythms, RHYTHMS_FRESH_MS } from './sources/rhythms'
import type { RhythmsConfig } from './sources/rhythms'

/** Where Sessions and Artifacts come from, as the work board's entry in `boards.json` names them. */
export type LiveConfig = {
  hosts?: Record<string, unknown>
  harnesses?: Record<string, unknown>
  sources?: Record<string, unknown>
  /** Every other board's file, by board id, for the `boards` Source. */
  boardPaths?: Record<string, string>
}

/** Everything the tree shows that the local file does not hold. */
export type Live = { items: Item[]; sessions: Session[]; artifacts: Artifact[]; errors: string[]; at: number }

const FRESH_MS = 15_000

let live: Live = { items: [], sessions: [], artifacts: [], errors: [], at: 0 }

export const liveNow = () => live

async function listHost($: EngineInterface, host: string): Promise<{ sessions: HostSession[]; error?: string }> {
  if (host === 'herdr') return listHerdr($)

  return { sessions: [], error: `boards.json names a host nothing reads: ${host}.` }
}

async function harnessInfo($: EngineInterface, harness: string, ids: string[]): Promise<Map<string, HarnessInfo>> {
  return harness === 'claude' ? claudeInfo($, ids) : new Map()
}

async function asked(source: string, ask: () => Promise<SourceAnswer>): Promise<SourceAnswer> {
  try {
    return await ask()
  } catch (err) {
    return { error: `${source}: ${messageOf(err)}` }
  }
}

/**
 * The external Sources' Items, each through the shared cache. Rhythms is reached through an MCP tool, which is asked
 * only from a call a person or Claude made (`force`); a timer reads what any session cached.
 */
async function sourceItems($: EngineInterface, config: LiveConfig, force: boolean, errors: string[]): Promise<Item[]> {
  const items: Item[] = []
  const linear = config.sources?.linear as LinearConfig | undefined
  if (linear) {
    const got = await readSource($, 'linear', LINEAR_FRESH_MS, () => asked('Linear', () => readLinear($, linear)))
    items.push(...(got.items ?? []))
    if (got.error) errors.push(got.error)
  }
  const rhythms = config.sources?.rhythms as RhythmsConfig | undefined
  if (rhythms) {
    const ask = force ? () => asked('Rhythms', () => readRhythms($, rhythms)) : undefined
    const got = await readSource($, 'rhythms', RHYTHMS_FRESH_MS, ask)
    items.push(...(got.items ?? []))
    if (got.error) errors.push(got.error)
  }

  const boards = config.sources?.boards as Record<string, string> | undefined
  if (boards) {
    const got = await readBoards($, boards, config.boardPaths ?? {})
    items.push(...(got.items ?? []))
    if (got.error) errors.push(got.error)
  }

  return items
}

/** Lists every configured Host's Sessions, the Artifacts sessions track and the external Sources' Items; true when that changed what is shown. */
export async function refreshLive($: EngineInterface, config: LiveConfig, force = false): Promise<boolean> {
  const now = await $.clock.now()
  if (!force && now - live.at < FRESH_MS) return false
  const errors: string[] = []
  const items = await sourceItems($, config, force, errors)
  const listed: Session[] = []
  for (const host of Object.keys(config.hosts ?? {})) {
    const answer = await listHost($, host)
    if (answer.error) errors.push(answer.error)
    for (const one of answer.sessions) listed.push({ ...one, id: `session:${host}:${one.address}`, host })
  }
  const held = listed.length > 0 || config.sources?.github !== undefined ? await storedValues($, 'board') : {}
  const sessions: Session[] = []
  for (const harness of new Set(listed.flatMap(one => (one.harness ? [one.harness] : [])))) {
    const mine = listed.filter(one => one.harness === harness)
    const info = await harnessInfo($, harness, mine.flatMap(one => (one.harnessId ? [one.harnessId] : [])))
    for (const one of mine) {
      const board = one.harnessId ? storedSessionBoard(held, one.harnessId) : undefined
      sessions.push({
        ...one,
        ...(one.harnessId ? info.get(one.harnessId) : {}),
        ...(board?.goal && { goal: board.goal }),
        ...(board?.summary && { summary: board.summary }),
      })
    }
  }
  sessions.push(...listed.filter(one => !one.harness))
  const artifacts = config.sources?.github !== undefined ? await readArtifacts($, held) : []
  const before = JSON.stringify([live.items, live.sessions, live.artifacts, live.errors])
  live = { items, sessions, artifacts, errors, at: now }

  return JSON.stringify([items, sessions, artifacts, errors]) !== before
}

/** The Session this one runs as, found by its own agent id among what the Hosts list. */
export async function selfSession($: EngineInterface, config: LiveConfig): Promise<Session | undefined> {
  const id = await $.session.id()
  await refreshLive($, config, true)

  return live.sessions.find(one => one.harnessId === id)
}

export async function focusSession($: EngineInterface, session: Session): Promise<string | undefined> {
  if (session.host === 'herdr') return focusHerdr($, session.address)

  return `No host ${session.host} to open it with.`
}

/**
 * Starts a Session through the first configured Host, running the first configured Harness. The result's id is the
 * Session's, which the Host lists once the agent is up.
 */
export async function startSession(
  $: EngineInterface,
  config: LiveConfig,
  start: Omit<HostStart, 'harness' | 'args'>,
): Promise<{ id?: string; error?: string }> {
  const host = Object.keys(config.hosts ?? {})[0]
  const harness = Object.keys(config.harnesses ?? {})[0]
  if (!host || !harness) return { error: 'boards.json names no host and harness to start a session with.' }
  if (host !== 'herdr') return { error: `No host ${host} to start a session with.` }
  const args = harness === 'claude' ? claudeArgs(config.harnesses?.[harness]) : []
  const started = await startHerdr($, { ...start, harness, args })
  if (!started.address) return { error: started.error ?? 'The session did not start.' }
  await refreshLive($, config, true)

  return { id: `session:${host}:${started.address}` }
}
