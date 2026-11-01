// What an hc `events.subscribe` connection knows: its snapshot's terminals as
// the API describes them, kept current by each `event` notification after it.
// The terminals stay in the API's own shape, so parseHcTerminals reads them.

export type HcTerminalFacts = { address: string } & Record<string, unknown>

/** The terminals of a snapshot (`events.subscribe`'s result), by address. */
export function hcSnapshot(result: unknown): Map<string, HcTerminalFacts> {
  const terminals = (result as { terminals?: unknown })?.terminals
  const known = new Map<string, HcTerminalFacts>()
  if (!Array.isArray(terminals)) return known
  for (const t of terminals) if (typeof t?.address === 'string') known.set(t.address, { ...t })
  return known
}

/**
 * The terminal fields each kind of event changes. Only these are taken: a
 * `turn` event also names the status in a `state` field, which is not the
 * terminal's own live or finished state.
 */
const FIELDS: Record<string, readonly string[]> = {
  status: ['status', 'reported', 'records'],
  title: ['title'],
  labels: ['labels'],
  turn: ['turn'],
  size: ['rows', 'cols'],
  keep: ['keep'],
  finished: ['exit_code', 'finished_ms', 'reason', 'signal'],
}

/**
 * Applies one `event` notification's params; gives the address it changed, or
 * undefined for an event it cannot read. `created` carries the whole terminal,
 * `foreground` the program itself, `removed` nothing, and the other kinds the
 * fields that changed.
 */
export function applyHcEvent(known: Map<string, HcTerminalFacts>, params: unknown): string | undefined {
  const { type, terminal, data } = (params ?? {}) as { type?: unknown; terminal?: unknown; data?: unknown }
  if (typeof type !== 'string' || typeof terminal !== 'string') return undefined
  const fields = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (type === 'created') {
    known.set(terminal, { ...fields, address: terminal })
    return terminal
  }
  if (type === 'removed') return known.delete(terminal) ? terminal : undefined
  const facts = known.get(terminal)
  if (!facts) return undefined
  if (type === 'foreground') {
    facts.foreground = fields
    return terminal
  }
  const changes = FIELDS[type]
  if (!changes) return undefined
  for (const key of changes) if (key in fields) facts[key] = fields[key]
  if (type === 'finished') facts.state = 'finished'
  return terminal
}
