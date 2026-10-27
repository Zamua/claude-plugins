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

export type Session = {
  id: string
  label: string
  workspace: string
  state: string
  parent?: string
  activeMs: number
}

export type Artifact = {
  id: string
  title: string
  url: string
  branch: string
  parent?: string
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
  depth: number
  /** The most urgent status in the subtree, which is what its line shows. */
  shown: Status
  /** Descendants whose own status is `needs`. */
  needsCount: number
}

export type Tree = {
  outcomes: Node[]
  responsibilities: Node[]
  byId: Map<string, Node>
  /** Items put at the top level because their parent is missing or would make a cycle. */
  warnings: string[]
  /** Ids whose parent was dropped to break a cycle. */
  cycles: string[]
}

export const rank = (status: Status) => URGENCY.indexOf(status)

const mostUrgent = (statuses: Status[]): Status =>
  statuses.reduce<Status>((best, one) => (rank(one) < rank(best) ? one : best), 'done')

/** A local id has no prefix; every other id names its Source before a colon. */
export const qualify = (id: string) => (id.includes(':') ? id : `file:${id}`)

export function buildTree(items: Item[], links: Link[]): Tree {
  const parentOf = new Map<string, string>()
  for (const item of items) if (item.parent) parentOf.set(item.id, item.parent)
  for (const link of links) parentOf.set(link.child, link.parent)
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
  for (const item of items) nodes.set(item.id, { item, children: [], depth: 0, shown: item.status, needsCount: 0 })
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
  for (const node of tops) rollUp(node, 0)
  const ordered = [...tops].sort(byUrgency)

  return {
    outcomes: ordered.filter(n => n.item.shape === 'outcome'),
    responsibilities: ordered.filter(n => n.item.shape === 'responsibility'),
    byId: nodes,
    warnings,
    cycles,
  }
}

/**
 * A leaf shows its own status. A parent shows its most urgent child, and its own status only when that is `needs`:
 * a project's own status says little once it has tasks, but a goal waiting on the person still does.
 */
function rollUp(node: Node, depth: number) {
  node.depth = depth
  for (const child of node.children) rollUp(child, depth + 1)
  node.children.sort(byUrgency)
  if (node.children.length === 0) return
  const own: Status[] = node.item.status === 'needs' ? ['needs'] : []
  node.shown = mostUrgent([...own, ...node.children.map(c => c.shown)])
  node.needsCount = node.children.reduce((sum, c) => sum + c.needsCount + (c.item.status === 'needs' ? 1 : 0), 0)
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
  const walk = (node: Node) => {
    const needs = node.needsCount > 0 ? `, ${node.needsCount} need you` : ''
    const ref = node.item.ref !== undefined ? ` #${node.item.ref}` : ''
    lines.push(`${'  '.repeat(node.depth)}${node.item.id}${ref} [${node.item.kind}, ${node.shown}${needs}] ${node.item.title}`)
    for (const child of node.children) walk(child)
  }
  if (tree.outcomes.length > 0) lines.push('Outcomes:')
  for (const node of tree.outcomes) walk(node)
  if (tree.responsibilities.length > 0) lines.push('Responsibilities:')
  for (const node of tree.responsibilities) walk(node)
  for (const warning of tree.warnings) lines.push(`warning: ${warning}`)

  return lines.length > 0 ? lines.join('\n') : 'The work board is empty.'
}

/** Every Item whose own status is `needs`, for the switcher's count. */
export const needsTotal = (tree: Tree) => [...tree.byId.values()].filter(n => n.item.status === 'needs').length
