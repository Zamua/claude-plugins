// Claude Code can move a running conversation to a background job (its agents
// panel). The job continues it under a new session id, the original transcript
// records the move as a `continued-in` entry, and the terminal's own process is
// left as a viewer. The topic's conversation is then the job's, and resuming the
// old id would drop everything said since.

/** At most this many moves are followed in one go, so a cycle cannot spin. */
export const MAX_HOPS = 8

/** A background job's id, as `claude stop` takes it: the first 8 hex digits of its session id. */
export const jobIdOf = (sessionId: string): string => sessionId.slice(0, 8)

/**
 * The session a transcript's conversation continues in, read from its last lines (the first may be cut).
 * Only a move that nothing conversational follows counts: a conversation resumed under the old id after
 * a move is still there, and its stale `continued-in` must not pull it away.
 */
export function continuedIn(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; continuedInSessionId?: unknown }
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (entry.type === 'user' || entry.type === 'assistant') return undefined
    if (entry.type === 'continued-in') {
      return typeof entry.continuedInSessionId === 'string' && entry.continuedInSessionId ? entry.continuedInSessionId : undefined
    }
  }
  return undefined
}

/**
 * The sessions a bound conversation moved through, oldest first, ending at the one it lives in now;
 * empty when it never moved. A move to a session with no transcript, or back to one already seen, ends it.
 */
export function movesFrom(bound: string, successor: (sessionId: string) => string | undefined, exists: (sessionId: string) => boolean): string[] {
  const seen = new Set([bound])
  const moves: string[] = []
  let current = bound
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = successor(current)
    if (!next || seen.has(next) || !exists(next)) break
    seen.add(next)
    moves.push(next)
    current = next
  }
  return moves
}

/** Posted when a topic's conversation is held by a background job, so resuming it would make two writers. */
export function parkedNotice(sessionId: string): string {
  const job = jobIdOf(sessionId)
  return (
    `This topic's conversation (${sessionId}) is running as background job ${job} in Claude Code's agents panel, ` +
    'so it was not resumed here: two processes would write the same conversation. ' +
    `Stop the job with \`claude stop ${job}\`, then send another message; yours stays queued.`
  )
}
