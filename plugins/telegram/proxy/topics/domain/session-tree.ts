// The session tree, at most two levels below the root: general's session is
// the root, every other topic is a project whose session is its coordinator,
// and a coordinator's workers hang under it. Only the root and the operator
// make projects; only a coordinator makes workers; a worker makes nothing. A
// project's topic becomes another's worker only through the admin's reparent.
// Who spawned a session is display only until the broker can prove a caller.
export type SessionNode = { parent: string | null; spawnedBy: string | null; spawnedAt: string | null }
export type Role = 'root' | 'coordinator' | 'worker'

export const ROOT = 'general'

/** The project a topic is recorded under as its worker; none for any other topic. */
function projectParent(topic: string, recorded?: SessionNode): string | null {
  const parent = recorded?.parent
  return parent && parent !== ROOT && parent !== topic ? parent : null
}

/** A topic's role: general is the root, a topic recorded under a project its worker, any other a project's coordinator. */
export const topicRole = (topic: string, recorded?: SessionNode): Role =>
  topic === ROOT ? 'root' : projectParent(topic, recorded) ? 'worker' : 'coordinator'

/** What a session of this role may spawn: the root projects, a coordinator workers, a worker nothing. */
export function spawns(role: Role): Role | undefined {
  return role === 'root' ? 'coordinator' : role === 'coordinator' ? 'worker' : undefined
}

/** The project a session belongs to: none for the root, its own topic for a coordinator, its coordinator's for a worker. */
export function projectOf(role: Role, id: string, parent: string | null): string | null {
  return role === 'root' ? null : role === 'coordinator' ? id : parent
}

/** A topic's node: the root has no parent, a worker hangs under its project, and every project under the root. */
export function sessionNode(topic: string, recorded?: SessionNode): SessionNode {
  return {
    parent: topic === ROOT ? null : projectParent(topic, recorded) ?? ROOT,
    spawnedBy: recorded?.spawnedBy ?? null,
    spawnedAt: recorded?.spawnedAt ?? null,
  }
}

/** The node of a project made now by `by`: "operator", "proxy", or the root's topic. */
export function spawnedNode(topic: string, by: string, at: string): SessionNode {
  return { ...sessionNode(topic), spawnedBy: by, spawnedAt: at }
}

/**
 * Why `topic` may not hang under `parent`, or nothing when it may: under the
 * root it is a project, under a project's coordinator its worker. A worker has
 * no workers, so a topic with workers stays a project.
 */
export function reparentRefusal(
  topic: string,
  parent: string,
  roleOf: (topic: string) => Role | undefined,
  hasWorkers: (topic: string) => boolean,
): string | undefined {
  if (parent === topic) return 'a topic cannot hang under itself'
  if (parent === ROOT) return undefined
  const role = roleOf(parent)
  if (!role) return `no project ${parent}`
  if (role !== 'coordinator') return `${parent} is a ${role}, not a project`
  if (hasWorkers(topic)) return `${topic} has workers of its own`
  return undefined
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
