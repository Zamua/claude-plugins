import { existsSync, readFileSync, renameSync } from 'fs'
import { writeJsonAtomic } from '../shared/json-file'
import type { PendingRouteChange, TopicRoute } from '../routing/domain/model-routing'

/** One topic's row in registry.json. Field values are coerced by the caller. */
export type RegistryEntry = {
  tmux_session: string
  thread_id: number | null
  name: string
  spawned_at: number
  claude_session_id?: string | null
  route?: TopicRoute | null
  launch_profile_version?: number | null
  pending_route?: PendingRouteChange | null
  exhausted_routes?: TopicRoute[] | null
  pending_resume_notice?: string | null
  /** Where the topic hangs in the session tree; absent for a topic that predates it. */
  session?: { parent: string | null; spawned_by: string | null; spawned_at: string | null } | null
  archived_at?: string | null
}

export type Registry = Record<string, RegistryEntry>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// The proxy rewrites the registry right after loading it, so a file that cannot
// be read is moved aside instead of read as empty: the rewrite would otherwise
// drop every topic's conversation id. If it cannot be moved aside, this throws
// rather than let that rewrite happen.
export function readRegistryFile(file: string, log: (m: string) => void, now = Date.now()): Registry {
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) throw new Error('top level is not an object')
  } catch (err) {
    const aside = `${file}.unreadable-${now}`
    try {
      renameSync(file, aside)
    } catch (renameErr) {
      throw new Error(`registry ${file} is unreadable (${reason(err)}) and could not be moved aside (${reason(renameErr)})`)
    }
    log(`registry: could not load ${file} (${reason(err)}); moved to ${aside}, starting empty`)
    return {}
  }
  const out: Registry = {}
  for (const [topic, entry] of Object.entries(parsed)) {
    if (isRecord(entry)) out[topic] = entry as RegistryEntry
    else log(`registry: dropping topic ${topic}, its entry is not an object`)
  }
  return out
}

export function writeRegistryFile(file: string, registry: Registry): void {
  writeJsonAtomic(file, registry)
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))
