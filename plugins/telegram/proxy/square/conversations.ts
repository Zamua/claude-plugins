import { readFileSync } from 'fs'
import { join } from 'path'
import { writeJsonAtomic } from '../adapters/json-file'
import { CONV_TTL_HOURS, STATE_DIR } from '../config'
import { log } from '../log'

// Durable + rederivable, content-free. One JSON file beside registry.json,
// atomic writes, bounded (LRU cap), TTL-pruned. The conv id is the root
// message id in the square thread; every non-root square message carries
// "#<conv>" in its header, so a lost file rebuilds lazily from
// reply_to_message payloads as replies arrive (self-describing messages).

export type Conv = {
  participants: string[] // topic keys ("34", "general"); the operator is an implicit participant of every conv
  last_msg_id: number
  origin_topic: string
  depth: number // DELIVERED claude messages since the last human message. Logged, never enforced.
  updated_at: number
}

export const CONV_FILE = join(STATE_DIR, 'conversations.json')
export const CONV_CAP = 50
export const convs = new Map<string, Conv>()

export function pruneConvs(): void {
  const cutoff = Date.now() - CONV_TTL_HOURS * 3600_000
  for (const [id, c] of convs) if (c.updated_at < cutoff) convs.delete(id)
  // LRU-close beyond the cap (oldest first).
  if (convs.size > CONV_CAP) {
    const sorted = [...convs.entries()].sort((a, b) => a[1].updated_at - b[1].updated_at)
    for (const [id] of sorted.slice(0, convs.size - CONV_CAP)) convs.delete(id)
  }
}

export function saveConvs(): void {
  pruneConvs()
  try {
    writeJsonAtomic(CONV_FILE, Object.fromEntries(convs))
  } catch (e) {
    log(`could not save conversations.json: ${e}`)
  }
}

export function loadConvs(): void {
  try {
    const raw = JSON.parse(readFileSync(CONV_FILE, 'utf8')) as Record<string, Conv>
    for (const [id, c] of Object.entries(raw)) convs.set(id, c)
    pruneConvs()
    log(`loaded ${convs.size} conversation(s)`)
  } catch {}
}
