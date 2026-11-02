// The session tree, at most two levels below the root: general's session is
// the root, every other topic is a project whose session is its coordinator,
// and a coordinator's workers hang under it. Only the root and the operator
// make projects; only a coordinator makes workers; a worker makes nothing.
// Who spawned a session is display only until the broker can prove a caller.
export type SessionNode = { parent: string | null; spawnedBy: string | null; spawnedAt: string | null }
export type Role = 'root' | 'coordinator' | 'worker'

export const ROOT = 'general'

/** A topic's role: general is the root, every other topic a project's coordinator. */
export const topicRole = (topic: string): Role => (topic === ROOT ? 'root' : 'coordinator')

/** What a session of this role may spawn: the root projects, a coordinator workers, a worker nothing. */
export function spawns(role: Role): Role | undefined {
  return role === 'root' ? 'coordinator' : role === 'coordinator' ? 'worker' : undefined
}

/** The project a session belongs to: none for the root, its own topic for a coordinator, its coordinator's for a worker. */
export function projectOf(role: Role, id: string, parent: string | null): string | null {
  return role === 'root' ? null : role === 'coordinator' ? id : parent
}

/** A topic's node: the root has no parent, and every project hangs under it, whoever made it. */
export function sessionNode(topic: string, recorded?: SessionNode): SessionNode {
  return {
    parent: topic === ROOT ? null : ROOT,
    spawnedBy: recorded?.spawnedBy ?? null,
    spawnedAt: recorded?.spawnedAt ?? null,
  }
}

/** The node of a project made now by `by`: "operator", "proxy", or the root's topic. */
export function spawnedNode(topic: string, by: string, at: string): SessionNode {
  return { ...sessionNode(topic), spawnedBy: by, spawnedAt: at }
}

/** Who may make a project: the operator, the proxy (the ask topic), or the root's session; a coordinator spawns workers instead. */
export function mayCreateProject(by: string): boolean {
  return by === 'operator' || by === 'proxy' || by === ROOT
}

/** A recorded node read back from storage; anything malformed is no record. */
export function sessionNodeFrom(value: unknown): SessionNode | undefined {
  const v = value as { parent?: unknown; spawned_by?: unknown; spawned_at?: unknown } | null
  if (!v || typeof v !== 'object') return undefined
  const textOrNull = (x: unknown) => (typeof x === 'string' && x ? x : null)
  return { parent: textOrNull(v.parent), spawnedBy: textOrNull(v.spawned_by), spawnedAt: textOrNull(v.spawned_at) }
}

/** Whether `topic` hangs under `ancestor`, following each node's parent. */
export function descendsFrom(topic: string, ancestor: string, parentOf: (topic: string) => string | null): boolean {
  const seen = new Set<string>()
  for (let parent = parentOf(topic); parent !== null && !seen.has(parent); parent = parentOf(parent)) {
    if (parent === ancestor) return true
    seen.add(parent)
  }
  return false
}
