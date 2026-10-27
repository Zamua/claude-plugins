import type { EngineInterface } from 'claude-code'

import { storedValues } from '../store'
import { storedSessionBoard } from '../views/session'
import { claudeArgs, claudeInfo } from './harnesses/claude'
import type { HarnessInfo } from './harnesses/claude'
import { focusHerdr, listHerdr, startHerdr } from './hosts/herdr'
import type { Artifact, HostSession, HostStart, Session } from './model'
import { readArtifacts } from './sources/github'

/** Where Sessions and Artifacts come from, as the work board's entry in `boards.json` names them. */
export type LiveConfig = {
  hosts?: Record<string, unknown>
  harnesses?: Record<string, unknown>
  sources?: Record<string, unknown>
}

export type Live = { sessions: Session[]; artifacts: Artifact[]; errors: string[]; at: number }

const FRESH_MS = 15_000

let live: Live = { sessions: [], artifacts: [], errors: [], at: 0 }

export const liveNow = () => live

async function listHost($: EngineInterface, host: string): Promise<{ sessions: HostSession[]; error?: string }> {
  if (host === 'herdr') return listHerdr($)

  return { sessions: [], error: `boards.json names a host nothing reads: ${host}.` }
}

async function harnessInfo($: EngineInterface, harness: string, ids: string[]): Promise<Map<string, HarnessInfo>> {
  return harness === 'claude' ? claudeInfo($, ids) : new Map()
}

/** Lists every configured Host's Sessions and the Artifacts sessions track; true when that changed what is shown. */
export async function refreshLive($: EngineInterface, config: LiveConfig, force = false): Promise<boolean> {
  const now = await $.clock.now()
  if (!force && now - live.at < FRESH_MS) return false
  const errors: string[] = []
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
  const before = JSON.stringify([live.sessions, live.artifacts, live.errors])
  live = { sessions, artifacts, errors, at: now }

  return JSON.stringify([sessions, artifacts, errors]) !== before
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
