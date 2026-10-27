import type { EngineInterface } from 'claude-code'

import { messageOf, span } from '../kit'
import type { SourceAnswer } from './model'

// Every session reads and writes these, so a Source several sessions show is asked once per freshness window
const CACHE_DIR = '.cache/board'
const IDLE_MS = 30 * 60_000
const PAUSE_MS = 10 * 60_000

type Entry = { at: number; answer: SourceAnswer; pausedUntil?: number; pauseReason?: string }

export type Cached = SourceAnswer & { at?: number }

let lastActive = 0

export async function markWorkActive($: EngineInterface) {
  lastActive = await $.clock.now()
}

async function readEntry($: EngineInterface, path: string): Promise<Entry | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined

    return JSON.parse(await $.fs.read(path)) as Entry
  } catch {
    // Another session may be mid-write; the Source is asked again rather than waited for
    return undefined
  }
}

async function writeEntry($: EngineInterface, path: string, entry: Entry) {
  try {
    await $.fs.write(path, JSON.stringify(entry))
  } catch {
    // An unwritten cache only means another session asks the Source again
  }
}

/**
 * The Source's answer from the shared cache while it is fresh, else from `ask`. A session nobody has used for a while
 * keeps the last answer instead of asking, and a failure keeps the last answer and pauses every session's asking.
 */
export async function readSource(
  $: EngineInterface,
  source: string,
  freshMs: number,
  ask: () => Promise<SourceAnswer>,
): Promise<Cached> {
  const path = `${await $.env.get('HOME')}/${CACHE_DIR}/${source}.json`
  const entry = await readEntry($, path)
  const now = await $.clock.now()
  const last: Cached = entry ? { ...entry.answer, at: entry.at } : {}
  if (entry && now - entry.at < freshMs) return last
  if (entry?.pausedUntil !== undefined && entry.pausedUntil > now) {
    return { ...last, error: `${entry.pauseReason ?? 'paused'}, retrying in ${span(entry.pausedUntil - now)}` }
  }
  if (entry && now - lastActive > IDLE_MS) return last

  let answer: SourceAnswer
  try {
    answer = await ask()
  } catch (err) {
    answer = { error: messageOf(err) }
  }
  if (answer.error) {
    const kept = entry ?? { at: 0, answer: {} }
    await writeEntry($, path, { ...kept, pausedUntil: now + PAUSE_MS, pauseReason: answer.error })

    return { ...last, error: answer.error }
  }
  await writeEntry($, path, { at: now, answer })

  return { ...answer, at: now }
}
