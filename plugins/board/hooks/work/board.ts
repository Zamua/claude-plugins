import type { EngineInterface } from 'claude-code'

import { refreshJson } from '../kit'
import { buildTree, followSessions, mergeItems, pathTo, qualify, sectionsOf } from './model'
import type { Period, Session, Tree } from './model'
import { liveNow, refreshLive, rememberItems } from './sessions'
import type { Live } from './sessions'
import { agentsOf, hiddenOf, isVersion2, itemsAndLinks, sectionMapOf, sectionNamesOf, withEtas } from './sources/file'
import type { LocalFile, LocalState } from './sources/file'

export const WORK_TOOL = 'mcp__board__work'
/** Names the Item a started session serves, in that session's environment; `$.env.get` spells it out. */
export const START_ENV = 'BOARD_WORK_ITEM'

/** A `model` board as `boards.json` names it. */
export type WorkSpec = {
  id: string
  title?: string
  path: string
  sources?: Record<string, unknown>
  hosts?: Record<string, unknown>
  harnesses?: Record<string, unknown>
  periods?: Period[]
  /** Every other board's file, by board id; set from `boards.json`, not written there. */
  boardPaths?: Record<string, string>
}

export type WorkBoard = {
  spec: WorkSpec
  path: string
  state: LocalState
  /** Lines about the config itself, such as a key nothing reads. */
  warnings: string[]
  /** Short names for link hosts, from `boards.json`. */
  labels: Record<string, string>
  /** The last press that failed, until the next one succeeds. */
  notice?: string | undefined
}

/** A board that belongs to one Item: its tab shows only in the sessions under that Item, and a line under the Item opens it. */
export type PlacedBoard = { id: string; title: string; under: string }

const SPEC_KEYS = new Set(['id', 'title', 'layout', 'path', 'sources', 'hosts', 'harnesses', 'periods'])
const POLL_MS = 15_000
// Sessions are listed only while someone looks at the view
const SHOWN_MS = 60_000

let board: WorkBoard | undefined
let placed: PlacedBoard[] = []
// What each placed board waits on the person for, by board id, as the pane counted it before drawing
let placedNeeds = new Map<string, number>()
let drawnAt = 0
// The Period the view is cut to, by name; empty shows every Item
let period = ''

export function configureWork(
  spec: WorkSpec | undefined,
  home: string,
  labels: Record<string, string> = {},
  boardPaths: Record<string, string> = {},
) {
  if (!spec) {
    board = undefined
    return
  }
  const unknown = Object.keys(spec).filter(key => !SPEC_KEYS.has(key))
  board = {
    spec: { ...spec, boardPaths },
    path: spec.path.startsWith('~/') ? home + spec.path.slice(1) : spec.path,
    state: {},
    warnings: unknown.length > 0 ? [`boards.json: ${spec.id} has keys nothing reads: ${unknown.join(', ')}.`] : [],
    labels,
  }
}

export const currentWork = () => board

/** The boards that belong to an Item, each drawn as a line under it. */
export function placeBoards(boards: PlacedBoard[]) {
  placed = boards.map(one => ({ ...one, under: qualify(one.under) }))
}

export const placedBoards = () => placed

export function countPlaced(needs: Map<string, number>) {
  placedNeeds = needs
}

export const placedNeedsNow = () => placedNeeds

/** Notes that the view was drawn, which keeps the Session list refreshing while someone looks. */
export function markDrawn(now: number) {
  drawnAt = now
}

/** The tree the local file holds now, with the Sessions and Artifacts last listed, or why there is none. */
export function workTree(file: unknown, live: Live = liveNow()): { tree?: Tree; error?: string } {
  if (file === undefined) return {}
  if (!isVersion2(file)) return { error: 'This board is in the old format. Run /board work migrate to move it into the work model.' }
  const local = file as LocalFile
  const { items, links: held } = itemsAndLinks(local)
  const { links, root } = followSessions(held, typeof local.root === 'string' ? local.root : undefined, agentsOf(local), live.sessions)
  const all = withEtas(mergeItems(items, live.items), local)
  const tree = buildTree(all, links, live.sessions, live.artifacts, root, live.past, hiddenOf(local))
  const titles = sectionNamesOf(local)

  return { tree: titles.length > 0 ? { ...tree, sections: sectionsOf(tree, titles, sectionMapOf(local)) } : tree }
}

export function periodsOf(spec: WorkSpec): Period[] {
  return (Array.isArray(spec.periods) ? spec.periods : []).filter(
    one => one && typeof one.name === 'string' && typeof one.start === 'string' && typeof one.end === 'string',
  )
}

/** The Period the view is cut to, by name; empty for every Item. */
export const chosenPeriod = () => period

export function setPeriod(name: string) {
  period = name
}

/** Cuts the view to the Period named, or to every Item for `all`; a name no Period has comes back as why. */
export function choosePeriod(name: string): string | undefined {
  const periods = board ? periodsOf(board.spec) : []
  if (name.toLowerCase() === 'all') {
    period = ''
    return undefined
  }
  const found = periods.find(one => one.name.toLowerCase() === name.toLowerCase())
  if (!found) {
    return periods.length > 0
      ? `No period ${name}. Periods: ${periods.map(one => one.name).join(', ')}, or all.`
      : 'boards.json names no periods for the work board.'
  }
  period = found.name

  return undefined
}

/** The root session the local file names, with the Session a Host lists for it while it runs. */
export function rootOf(tree: Tree): { id: string; session?: Session } | undefined {
  const id = tree.root
  if (id === undefined) return undefined
  const session = tree.sessions.get(id)

  return session ? { id, session } : { id }
}

/** This session as a Host lists it, and the Item it serves: its attachment, else the Item it was started for. */
export async function selfOf($: EngineInterface, tree: Tree): Promise<{ session?: Session; item?: string }> {
  const harnessId = await $.session.id()
  const session = [...tree.sessions.values()].find(one => one.harnessId === harnessId)
  const attached = session ? tree.sessionItem.get(session.id) : undefined
  const started = await $.env.get('BOARD_WORK_ITEM')
  const item = attached ?? (started && tree.byId.has(qualify(started)) ? qualify(started) : undefined)

  return { ...(session && { session }), ...(item && { item }) }
}

/**
 * Whether this session works under `under`: its own Item sits at or below it, or the Item of a session coordinating it,
 * up the chain, does.
 */
export async function isWithin($: EngineInterface, under: string): Promise<boolean> {
  const w = board
  if (!w) return false
  if (liveNow().at === 0) await refreshLive($, w.spec)
  const tree = workTree(w.state.value).tree
  if (!tree) return false
  const target = qualify(under)
  const self = await selfOf($, tree)
  const items = self.item ? [self.item] : []
  const seen = new Set<string>()
  for (let at = self.session?.id; at && !seen.has(at); at = tree.coordinatorOf.get(at)) {
    seen.add(at)
    const up = tree.coordinatorOf.get(at)
    const item = up ? tree.sessionItem.get(up) : undefined
    if (item) items.push(item)
  }

  return items.some(item => pathTo(tree, item).some(one => one.id === target))
}

export async function workRefresh($: EngineInterface, force = false) {
  if (!board) return
  const fileChanged = await refreshJson($, board.state, board.path)
  const isShown = force || (await $.clock.now()) - drawnAt < SHOWN_MS
  const liveChanged = isShown && (await refreshLive($, board.spec, force))
  if (liveChanged) {
    const tree = workTree(board.state.value).tree
    if (tree) await rememberItems($, tree.sessionItem)
  }
  if (fileChanged || liveChanged) $.ui.invalidate('ui.render')
}

export async function workStart($: EngineInterface) {
  await workRefresh($)
  $.clock.every(POLL_MS, () => workRefresh($))
}
