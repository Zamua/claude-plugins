/** The statuses every Item shares, most urgent first. */
export const URGENCY = ['needs', 'flight', 'waiting', 'next', 'watching', 'done'] as const
export type Status = (typeof URGENCY)[number]

export type Shape = 'outcome' | 'responsibility'

export const ORIGINS = ['planned', 'asked', 'interrupt', 'self'] as const
export type Origin = { type: (typeof ORIGINS)[number]; by?: string }

export type ItemLink = { label?: string; url: string }

export type Item = {
  /** `<source>:<native id>`, unique across Sources. */
  id: string
  source: string
  kind: string
  title: string
  url?: string
  shape: Shape
  status: Status
  /** Its Source keeps the status current, so it counts in its own rollup even once it has children. */
  isStatusLive?: boolean
  origin?: Origin
  parent?: string
  /** Identifiers a session or pull request may carry in its name. */
  aliases: string[]
  target?: string
  targetLabel?: string
  started?: string
  finished?: string
  progress?: number
  checkinDue?: string
  owner?: string
  detail?: string
  links: ItemLink[]
  ref?: number
  workspace?: string
}

export const SESSION_STATES = ['waiting', 'done', 'working', 'idle'] as const
/** How a Session stands, most in need of a look first; `done` is a finished turn nobody has looked at. */
export type SessionState = (typeof SESSION_STATES)[number]

/** A Session as a Host lists it, before the core places it. */
export type HostSession = {
  /** The Host's own locator, opaque to the core. */
  address: string
  label: string
  /** The Host's name for the set of sessions it runs this one in, matched like the label. */
  group?: string
  state: SessionState
  harness?: string
  /** The Harness's own id for the agent there now. */
  harnessId?: string
}

/** What a Host needs to start a Session. `near` is the starting Session's address, so it can start beside it. */
export type HostStart = {
  label: string
  cwd: string
  harness: string
  args: string[]
  brief: string
  near?: string
  /** Set in the new session's environment. */
  env?: Record<string, string>
}

export type Session = HostSession & {
  /** `session:<host>:<address>`: the place it runs, which outlives the agent's own id. */
  id: string
  host: string
  messageName?: string
  goal?: string
  summary?: string
  lastActive?: number
  /** Time the person and the agent spent in it, from its Harness. */
  activeMs?: number
}

/** A Session no Host lists any more, by the Item it last sat under, so its time still counts there. */
export type PastTime = { item: string; activeMs: number }

/** Something an Item produces, drawn under it with its own status. */
export type Artifact = {
  id: string
  title: string
  url: string
  branch: string
  /** A short handle drawn before the title, such as a pull request number. */
  tag: string
  status: Status
  /** Why it needs the person, when it does. */
  note?: string
}

/** A parent set by hand, which wins over the parent a Source gives. */
export type Link = { child: string; parent: string; at: string }

export type Period = { name: string; start: string; end: string }

export type SourceAnswer = {
  items?: Item[]
  sessions?: Session[]
  artifacts?: Artifact[]
  error?: string
}

export type Node = {
  item: Item
  parent?: Node
  children: Node[]
  sessions: Session[]
  artifacts: Artifact[]
  depth: number
  /** The most urgent status in the subtree, which is what its line shows. */
  shown: Status
  /** Descendants whose own status is `needs`. */
  needsCount: number
  /** The active time of every Session in the subtree, finished ones included. */
  activeMs: number
}

export type Tree = {
  outcomes: Node[]
  responsibilities: Node[]
  /** Asks with no parent yet, until they are placed. */
  inbox: Node[]
  byId: Map<string, Node>
  /** Items put at the top level because their parent is missing or would make a cycle. */
  warnings: string[]
  /** Ids whose parent was dropped to break a cycle. */
  cycles: string[]
  sessions: Map<string, Session>
  /** Each Session's Item, by Session id. */
  sessionItem: Map<string, string>
  /** The Sessions each Coordinator started or tracks, by Coordinator id. */
  coordinated: Map<string, Session[]>
  coordinatorOf: Map<string, string>
  unplaced: { sessions: Session[]; artifacts: Artifact[] }
  /** The root session's id, which sits above the tree rather than in it. */
  root?: string
}

export const rank = (status: Status) => URGENCY.indexOf(status)

const mostUrgent = (statuses: Status[]): Status =>
  statuses.reduce<Status>((best, one) => (rank(one) < rank(best) ? one : best), 'done')

/** A local id has no prefix; every other id names its Source before a colon. */
export const qualify = (id: string) => (id.includes(':') ? id : `file:${id}`)

export const isSessionId = (id: string) => id.startsWith('session:')

export function buildTree(
  items: Item[],
  links: Link[],
  sessions: Session[] = [],
  artifacts: Artifact[] = [],
  root?: string,
  past: PastTime[] = [],
): Tree {
  const parentOf = new Map<string, string>()
  for (const item of items) if (item.parent) parentOf.set(item.id, item.parent)
  for (const link of links) if (!isSessionId(link.child)) parentOf.set(link.child, link.parent)
  const known = new Map(items.map(item => [item.id, item]))
  const warnings: string[] = []
  const cycles: string[] = []

  for (const item of items) {
    const seen = new Set([item.id])
    let at = parentOf.get(item.id)
    while (at !== undefined && known.has(at)) {
      if (seen.has(at)) {
        parentOf.delete(item.id)
        cycles.push(item.id)
        warnings.push(`${item.title} sits at the top: its parent would make a cycle.`)
        break
      }
      seen.add(at)
      at = parentOf.get(at)
    }
  }

  const nodes = new Map<string, Node>()
  for (const item of items) {
    nodes.set(item.id, { item, children: [], sessions: [], artifacts: [], depth: 0, shown: item.status, needsCount: 0, activeMs: 0 })
  }
  const tops: Node[] = []
  for (const item of items) {
    const node = nodes.get(item.id) as Node
    const parent = parentOf.get(item.id)
    const holder = parent === undefined ? undefined : nodes.get(parent)
    if (parent !== undefined && !holder) warnings.push(`${item.title} sits at the top: no Item ${parent}.`)
    if (holder) {
      holder.children.push(node)
      node.parent = holder
    } else {
      tops.push(node)
    }
  }
  for (const node of tops) setDepth(node, 0)
  const placed = place(nodes, links, sessions, artifacts, root)
  for (const node of nodes.values()) node.activeMs = node.sessions.reduce((sum, s) => sum + (s.activeMs ?? 0), 0)
  for (const one of past) {
    const node = nodes.get(one.item)
    if (node) node.activeMs += one.activeMs
  }
  for (const node of tops) rollUp(node)
  const ordered = [...tops].sort(byUrgency)
  const isAsk = (n: Node) => n.item.origin?.type === 'asked' && !parentOf.has(n.item.id)

  return {
    outcomes: ordered.filter(n => n.item.shape === 'outcome' && !isAsk(n)),
    responsibilities: ordered.filter(n => n.item.shape === 'responsibility'),
    inbox: ordered.filter(n => n.item.shape === 'outcome' && isAsk(n)),
    byId: nodes,
    warnings,
    cycles,
    ...placed,
    ...(root && { root }),
  }
}

function setDepth(node: Node, depth: number) {
  node.depth = depth
  for (const child of node.children) setDepth(child, depth + 1)
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `alias` appears in `text` as a whole token, bounded by anything not a letter or digit. */
export const carries = (text: string, alias: string) =>
  alias !== '' && new RegExp(`(^|[^a-z0-9])${escaped(alias.toLowerCase())}($|[^a-z0-9])`).test(text.toLowerCase())

/**
 * The Item whose aliases appear in any of `texts`. An unfinished Item beats a done one, and then the deepest wins;
 * two equally deep leave it unplaced.
 */
function matchItem(nodes: Map<string, Node>, texts: string[]): Node | undefined {
  const hits = [...nodes.values()].filter(n => n.item.aliases.some(alias => texts.some(text => carries(text, alias))))
  const open = hits.filter(n => n.item.status !== 'done')
  const pool = open.length > 0 ? open : hits
  const deepest = Math.max(-1, ...pool.map(n => n.depth))
  const best = pool.filter(n => n.depth === deepest)

  return best.length === 1 ? best[0] : undefined
}

/** Puts each Session and Artifact under its Item: a hand Link first, then an alias in its name. */
function place(nodes: Map<string, Node>, links: Link[], sessions: Session[], artifacts: Artifact[], root?: string) {
  const itemLink = new Map<string, string>()
  const coordinatorOf = new Map<string, string>()
  for (const link of links) {
    if (isSessionId(link.parent)) coordinatorOf.set(link.child, link.parent)
    else itemLink.set(link.child, link.parent)
  }
  const byId = new Map(sessions.map(one => [one.id, one]))
  const sessionItem = new Map<string, string>()
  const coordinated = new Map<string, Session[]>()
  const unplaced = { sessions: [] as Session[], artifacts: [] as Artifact[] }
  for (const session of sessions) {
    const linked = itemLink.get(session.id)
    const node = (linked ? nodes.get(linked) : undefined) ?? matchItem(nodes, [session.label, ...(session.group ? [session.group] : [])])
    const coordinator = coordinatorOf.get(session.id)
    if (coordinator && byId.has(coordinator)) coordinated.set(coordinator, [...(coordinated.get(coordinator) ?? []), session])
    if (node) {
      node.sessions.push(session)
      sessionItem.set(session.id, node.item.id)
    } else if ((!coordinator || !byId.has(coordinator)) && session.id !== root) {
      unplaced.sessions.push(session)
    }
  }
  for (const artifact of artifacts) {
    const linked = itemLink.get(artifact.id)
    const node = (linked ? nodes.get(linked) : undefined) ?? matchItem(nodes, [artifact.title, artifact.branch])
    if (node) node.artifacts.push(artifact)
    else if (artifact.status !== 'done') unplaced.artifacts.push(artifact)
  }

  return { sessions: byId, sessionItem, coordinated, coordinatorOf, unplaced }
}

/**
 * A leaf shows its own status. A parent shows its most urgent child, and its own status only when that is `needs` or
 * its Source keeps it current: a hand-kept project's own status says little once it has tasks, but a goal waiting on
 * the person still does. An Artifact only adds urgency: one that needs the person counts like an Item that does, and
 * a merged one leaves its Item as is.
 */
function rollUp(node: Node) {
  for (const child of node.children) rollUp(child)
  node.children.sort(byUrgency)
  const artifactNeeds = node.artifacts.filter(a => a.status === 'needs').length
  if (node.children.length > 0) {
    const own: Status[] = node.item.status === 'needs' || node.item.isStatusLive ? [node.item.status] : []
    node.shown = mostUrgent([...own, ...node.children.map(c => c.shown)])
  }
  if (artifactNeeds > 0) node.shown = 'needs'
  node.needsCount =
    artifactNeeds + node.children.reduce((sum, c) => sum + c.needsCount + (c.item.status === 'needs' ? 1 : 0), 0)
  node.activeMs += node.children.reduce((sum, c) => sum + c.activeMs, 0)
}

const DAY_MS = 24 * 3600e3

/**
 * The Items a Period shows: each whose own dates fall in it, an undated one under such an Item, and the ancestors of
 * both, so the work under a quarter's goal shows with it. A Responsibility runs through every Period, as does an ask
 * waiting in the Inbox.
 */
export function inPeriod(tree: Tree, period: Period): Set<string> {
  const start = Date.parse(period.start)
  // The end date is the Period's last whole day
  const end = Date.parse(period.end) + DAY_MS
  const shown = new Set<string>()
  const show = (node: Node) => {
    for (let at: Node | undefined = node; at && !shown.has(at.item.id); at = at.parent) shown.add(at.item.id)
  }
  const visit = (node: Node, inherited: boolean) => {
    const dates = [node.item.target, node.item.started, node.item.finished]
      .map(date => (date ? Date.parse(date) : NaN))
      .filter(at => !Number.isNaN(at))
    const isIn = dates.length === 0 ? inherited : dates.some(at => at >= start && at < end)
    if (isIn) show(node)
    for (const child of node.children) visit(child, isIn)
  }
  for (const node of tree.outcomes) visit(node, false)
  for (const node of [...tree.responsibilities, ...tree.inbox]) visit(node, true)

  return shown
}

const byUrgency = (a: Node, b: Node) => rank(a.shown) - rank(b.shown)

/** True when `ancestor` is `id` or lies above it. */
export function isWithin(tree: Tree, id: string, ancestor: string): boolean {
  for (let node = tree.byId.get(id); node; node = node.parent) {
    if (node.item.id === ancestor) return true
  }

  return false
}

/** The tree as text, one line per Item, for the tool's read. */
export function treeText(tree: Tree): string {
  const lines: string[] = []
  const { root } = tree
  const rootSession = root ? tree.sessions.get(root) : undefined
  if (root) lines.push(rootSession ? `Root session: ${sessionText(tree, rootSession, '')[0]}` : `Root session: ${root}, not running`)
  const walk = (node: Node) => {
    const needs = node.needsCount > 0 ? `, ${node.needsCount} need you` : ''
    const ref = node.item.ref !== undefined ? ` #${node.item.ref}` : ''
    const pad = '  '.repeat(node.depth)
    const time = node.activeMs >= 60_000 ? `, ${Math.round(node.activeMs / 60_000)}m spent` : ''
    const by = node.item.origin?.by ? `, asked by ${node.item.origin.by}` : ''
    lines.push(`${pad}${node.item.id}${ref} [${node.item.kind}, ${node.shown}${needs}${time}${by}] ${node.item.title}`)
    for (const session of node.sessions) lines.push(...sessionText(tree, session, `${pad}  `))
    for (const artifact of node.artifacts) lines.push(`${pad}  ${artifact.id} [${artifact.status}] ${artifact.title}`)
    for (const child of node.children) walk(child)
  }
  if (tree.outcomes.length > 0) lines.push('Outcomes:')
  for (const node of tree.outcomes) walk(node)
  if (tree.responsibilities.length > 0) lines.push('Responsibilities:')
  for (const node of tree.responsibilities) walk(node)
  if (tree.inbox.length > 0) lines.push('Inbox:')
  for (const node of tree.inbox) walk(node)
  if (tree.unplaced.sessions.length > 0) lines.push('Unplaced sessions:')
  for (const session of tree.unplaced.sessions) lines.push(...sessionText(tree, session, ''))
  for (const warning of tree.warnings) lines.push(`warning: ${warning}`)

  return lines.length > 0 ? lines.join('\n') : 'The work board is empty.'
}

/**
 * Every Source's Items, once each. An external Item that a local Item already names by alias is left out, and its
 * children sit under the local Item instead, since the local one is where the person placed it.
 */
export function mergeItems(local: Item[], external: Item[]): Item[] {
  const byAlias = new Map<string, string>()
  for (const item of local) for (const alias of item.aliases) byAlias.set(alias.toLowerCase(), item.id)
  const replaced = new Map<string, string>()
  for (const item of external) {
    const named = item.aliases.map(alias => byAlias.get(alias.toLowerCase())).find(Boolean)
    if (named) replaced.set(item.id, named)
  }
  const kept = external
    .filter(item => !replaced.has(item.id))
    .map(item => (item.parent && replaced.has(item.parent) ? { ...item, parent: replaced.get(item.parent) } : item))

  return [...local, ...kept]
}

/** The Items from the top of the tree down to `id`. */
export function pathTo(tree: Tree, id: string): Item[] {
  const out: Item[] = []
  for (let node = tree.byId.get(id); node; node = node.parent) out.unshift(node.item)

  return out
}

/** A Session's line, its board's goal and summary, then the Sessions it coordinates that sit under no Item. */
function sessionText(tree: Tree, session: Session, pad: string): string[] {
  const message = session.messageName ? `, message ${session.messageName}` : ''
  const coordinator = tree.coordinatorOf.get(session.id)
  const by = coordinator && tree.sessions.has(coordinator) ? `, coordinated by ${coordinator}` : ''
  const out = [`${pad}${session.id} [${session.state}] ${session.label}${message}${by}`]
  if (session.goal) out.push(`${pad}  goal: ${session.goal}`)
  if (session.summary) out.push(`${pad}  summary: ${session.summary.replace(/\s*\n\s*/g, ' ')}`)
  for (const child of tree.coordinated.get(session.id) ?? []) {
    if (!tree.sessionItem.has(child.id)) out.push(...sessionText(tree, child, `${pad}  `))
  }

  return out
}

/** Every Item whose own status is `needs`, for the switcher's count. */
export const needsTotal = (tree: Tree) => [...tree.byId.values()].filter(n => n.item.status === 'needs').length
