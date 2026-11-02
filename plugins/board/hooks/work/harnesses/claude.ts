import type { EngineInterface } from 'claude-code'

import type { PastTime } from '../model'

type SessionRecord = { sessionId?: string; name?: string; updatedAt?: number }

export type HarnessInfo = { messageName?: string; lastActive?: number; activeMs?: number }

type TimeEntry = {
  path?: string
  mtimeMs?: number
  /** Bytes of the transcript counted so far, so a recount reads only what was appended. */
  size?: number
  /** The last minute counted, as epoch milliseconds, where the appended minutes continue from. */
  last?: number
  at: number
  activeMs: number
  item?: string
}
type TimeCache = { sessions: Record<string, TimeEntry> }

const TIME_FILE = '.cache/board/time.json'
const GAP_MS = 5 * 60_000
// A transcript still being written is counted again at most this often, since a long one takes a while to read
const RECOUNT_MS = 5 * 60_000
const KEEP_MS = 90 * 24 * 3600e3
// A transcript runs to hundreds of megabytes, past what one file read takes, so grep cuts the bytes from an offset on
// to the minutes they have entries in, in order, one line each. Every session counts the same transcripts, so a count
// runs at low priority and only over what was appended since the last one.
const MINUTES = [
  'sh',
  '-c',
  'tail -c +"$2" "$1" | nice -n 15 grep -o \'"timestamp":"[^"]*\' | cut -c14-29 | uniq',
  'minutes',
]
const COUNT_TIMEOUT_MS = 60_000
// A transcript counted from its start costs a full read, so a pass makes at most this many and leaves the rest to later passes
const FULL_COUNTS_PER_PASS = 1

async function configDir($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
}

/**
 * What Claude Code's own session records say of each agent: the name its messaging addresses it by, and when it last
 * changed. A record lives in `sessions/<pid>.json` under the config directory, so it is found by its `sessionId`.
 */
export async function claudeInfo($: EngineInterface, harnessIds: string[]): Promise<Map<string, HarnessInfo>> {
  const out = new Map<string, HarnessInfo>()
  const wanted = new Set(harnessIds)
  if (wanted.size === 0) return out
  const dir = `${await configDir($)}/sessions`
  if (!(await $.fs.exists(dir))) return out
  for (const file of await $.fs.list(dir)) {
    if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
    try {
      const record = JSON.parse(await $.fs.read(`${dir}/${file.name}`)) as SessionRecord
      if (!record.sessionId || !wanted.has(record.sessionId)) continue
      out.set(record.sessionId, {
        ...(record.name && { messageName: record.name }),
        ...(typeof record.updatedAt === 'number' && { lastActive: record.updatedAt }),
      })
    } catch {
      // A record mid-write reads as missing until the next refresh
    }
  }

  return out
}

/** The arguments Claude Code starts with, from `harnesses.claude.args`, with `model` over the one they name. */
export function claudeArgs(config: unknown, model?: string): string[] {
  const listed = (config as { args?: unknown } | undefined)?.args
  const args = Array.isArray(listed) ? listed.filter((one): one is string => typeof one === 'string') : []
  if (!model) return args
  const at = args.indexOf('--model')

  return at >= 0 ? args.map((one, i) => (i === at + 1 ? model : one)) : [...args, '--model', model]
}

/**
 * The time a transcript's entries span, from the minutes they fall in, such as `2026-10-27T19:32`, with every gap over
 * five minutes cut out, so idle hours do not count.
 */
export function activeTime(minutes: string): number {
  return spanOf(minutes).activeMs
}

/** `activeTime` over minutes that continue from `from`, the last minute already counted, with the new last minute. */
function spanOf(minutes: string, from?: number): { activeMs: number; last?: number } {
  const stamps = [...new Set(minutes.split('\n').map(line => Date.parse(`${line.trim()}Z`)))]
    .filter(at => !Number.isNaN(at) && (from === undefined || at >= from))
    .sort((a, b) => a - b)
  if (from !== undefined && stamps[0] !== from) stamps.unshift(from)
  let total = 0
  for (let at = 1; at < stamps.length; at++) {
    const gap = (stamps[at] as number) - (stamps[at - 1] as number)
    if (gap <= GAP_MS) total += gap
  }
  const last = stamps[stamps.length - 1]

  return { activeMs: total, ...(last !== undefined && { last }) }
}

async function readTimes($: EngineInterface, path: string): Promise<TimeCache> {
  try {
    if (!(await $.fs.exists(path))) return { sessions: {} }
    const cache = JSON.parse(await $.fs.read(path)) as TimeCache

    return { sessions: cache.sessions ?? {} }
  } catch {
    // Another session may be mid-write; the times are counted again
    return { sessions: {} }
  }
}

/** Where Claude Code keeps an agent's transcript: `projects/<its directory>/<session id>.jsonl`. */
async function transcriptOf($: EngineInterface, id: string): Promise<string | undefined> {
  const projects = `${await configDir($)}/projects`
  if (!(await $.fs.exists(projects))) return undefined
  for (const dir of await $.fs.list(projects)) {
    if (dir.kind !== 'dir') continue
    const path = `${projects}/${dir.name}/${id}.jsonl`
    if (await $.fs.exists(path)) return path
  }

  return undefined
}

// Set while this process counts, so a refresh that starts before the last one finished reads the cache instead
let isCounting = false

/**
 * Each running agent's active time, and the time of agents no Host lists any more, by the Item they last sat under.
 * A transcript is read again only once it has changed, and then only from where the last count stopped.
 */
export async function claudeTime($: EngineInterface, ids: string[]): Promise<{ active: Map<string, number>; past: PastTime[] }> {
  const path = `${await $.env.get('HOME')}/${TIME_FILE}`
  const now = await $.clock.now()
  if (isCounting) {
    const { active, past } = timesOf(await readTimes($, path), ids, now)
    return { active, past }
  }
  isCounting = true
  try {
    const active = new Map<string, number>()
    let fullCounts = 0
    for (const id of ids) {
      // Read again before each transcript, since another session may have just counted it
      const cache = await readTimes($, path)
      const entry = cache.sessions[id]
      try {
        const transcript = entry?.path ?? (await transcriptOf($, id))
        if (!transcript) continue
        const stat = await $.fs.stat(transcript).catch(() => undefined)
        if (entry && (entry.mtimeMs === stat?.mtimeMs || now - entry.at < RECOUNT_MS)) {
          active.set(id, entry.activeMs)
          continue
        }
        const isAppended = entry?.size !== undefined && stat !== undefined && stat.size >= entry.size
        if (!isAppended && fullCounts >= FULL_COUNTS_PER_PASS) {
          if (entry) active.set(id, entry.activeMs)
          continue
        }
        if (!isAppended) fullCounts++
        const offset = isAppended ? (entry?.size ?? 0) + 1 : 1
        const counted = await $.process.run([...MINUTES, transcript, String(offset)], { timeoutMs: COUNT_TIMEOUT_MS })
        if (counted.exitCode !== 0 && counted.stdout === '') continue
        const span = spanOf(counted.stdout, isAppended ? entry?.last : undefined)
        const activeMs = (isAppended ? (entry?.activeMs ?? 0) : 0) + span.activeMs
        cache.sessions[id] = {
          ...entry,
          path: transcript,
          ...(stat && { mtimeMs: stat.mtimeMs, size: stat.size }),
          ...(span.last !== undefined && { last: span.last }),
          at: now,
          activeMs,
        }
        active.set(id, activeMs)
        await $.fs.write(path, JSON.stringify(cache)).catch(() => undefined)
      } catch {
        // A transcript that cannot be counted leaves its session's time as last counted
        if (entry) active.set(id, entry.activeMs)
      }
    }
    const cache = await readTimes($, path)
    const { past, isPruned } = timesOf(cache, ids, now)
    if (isPruned) await $.fs.write(path, JSON.stringify(cache)).catch(() => undefined)

    return { active, past }
  } finally {
    isCounting = false
  }
}

/** The times the cache holds, running agents' and finished ones', pruning entries past KEEP_MS from `cache`. */
function timesOf(cache: TimeCache, ids: string[], now: number) {
  const live = new Set(ids)
  const active = new Map<string, number>()
  const past: PastTime[] = []
  let isPruned = false
  for (const [id, entry] of Object.entries(cache.sessions)) {
    if (now - entry.at > KEEP_MS) {
      delete cache.sessions[id]
      isPruned = true
    } else if (live.has(id)) {
      active.set(id, entry.activeMs)
    } else if (entry.item && entry.activeMs > 0) {
      past.push({ item: entry.item, activeMs: entry.activeMs })
    }
  }

  return { active, past, isPruned }
}

/** Remembers the Item each running agent sits under, so its time stays there once it has finished. */
export async function recordItems($: EngineInterface, items: Map<string, string>) {
  const path = `${await $.env.get('HOME')}/${TIME_FILE}`
  const cache = await readTimes($, path)
  let isChanged = false
  for (const [id, item] of items) {
    const entry = cache.sessions[id]
    if (!entry || entry.item === item) continue
    entry.item = item
    isChanged = true
  }
  if (isChanged) await $.fs.write(path, JSON.stringify(cache)).catch(() => undefined)
}
