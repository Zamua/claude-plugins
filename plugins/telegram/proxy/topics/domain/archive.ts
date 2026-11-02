// Archiving a project: it stops and leaves the lists, its conversation untouched,
// until it is restored or something wakes it.
import { ROOT } from './session-tree'

export const RESTORED_NOTICE = '📂 restored from the archive: same conversation, picking up where it left off.'

export type ArchiveOutcome = 'archived' | 'already_archived' | 'restored' | 'not_archived' | 'renamed' | 'unchanged' | 'unknown' | 'refused'
export type ArchiveResult = { topic: string; outcome: ArchiveOutcome; reason?: string }

/** Why a topic cannot be archived or renamed from here, if it cannot: the root and the square are not projects. */
export function notAProject(topic: string, exists: boolean, square: string | undefined): ArchiveResult | undefined {
  if (topic === ROOT) return { topic, outcome: 'refused', reason: `${ROOT} is the root, not a project` }
  if (square && topic === square) return { topic, outcome: 'refused', reason: 'the square is not a project' }
  if (!exists) return { topic, outcome: 'unknown' }
  return undefined
}
