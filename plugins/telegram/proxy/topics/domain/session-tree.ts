// Where each topic hangs in the session tree: general is the root, a topic an
// agent created hangs under that agent's topic, and any other under general.
// Who spawned a topic is display only until the broker can prove a caller.
export type SessionNode = { parent: string | null; spawnedBy: string | null; spawnedAt: string | null }

export const ROOT = 'general'

/** A topic's node: the one recorded, or, for a topic that predates the tree, the root or a child of it. */
export function sessionNode(topic: string, recorded?: SessionNode): SessionNode {
  if (topic === ROOT) return { parent: null, spawnedBy: recorded?.spawnedBy ?? null, spawnedAt: recorded?.spawnedAt ?? null }
  return recorded ?? { parent: ROOT, spawnedBy: null, spawnedAt: null }
}

/**
 * The node of a topic spawned now by `by`: "operator", "proxy" or a topic's id.
 * It hangs under its creator when that is another known topic, else under the
 * root. A new topic is no one's ancestor, so this never makes a cycle.
 */
export function spawnedNode(topic: string, by: string, isTopic: (id: string) => boolean, at: string): SessionNode {
  return { parent: by !== topic && isTopic(by) ? by : ROOT, spawnedBy: by, spawnedAt: at }
}

/** A recorded node read back from storage; anything malformed is no record. */
export function sessionNodeFrom(value: unknown): SessionNode | undefined {
  const v = value as { parent?: unknown; spawned_by?: unknown; spawned_at?: unknown } | null
  if (!v || typeof v !== 'object') return undefined
  const textOrNull = (x: unknown) => (typeof x === 'string' && x ? x : null)
  return { parent: textOrNull(v.parent), spawnedBy: textOrNull(v.spawned_by), spawnedAt: textOrNull(v.spawned_at) }
}
