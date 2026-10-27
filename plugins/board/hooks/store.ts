import type { EngineInterface } from 'claude-code'

const SAVED_BOARDS = 40

/**
 * A view's board is copied to `$.store` under `<prefix>:<session id>` so a resumed session gets it back. The oldest
 * copies past SAVED_BOARDS are dropped, and a copy written under another shape reads as none.
 */
export async function saveBoard($: EngineInterface, prefix: string, shape: string, value: { sessionId: string }) {
  const key = `${prefix}:${value.sessionId}`
  await $.store.set(key, { shape, value })
  const older = (await $.store.keys()).filter(one => one.startsWith(`${prefix}:`) && one !== key)
  for (const one of older.slice(0, Math.max(0, older.length - SAVED_BOARDS + 1))) {
    await $.store.delete(one)
  }
}

export async function loadBoard<T>($: EngineInterface, prefix: string, shape: string, sessionId: string) {
  const saved = await $.store.get(`${prefix}:${sessionId}`)
  const isBoard = typeof saved === 'object' && saved !== null && (saved as { shape?: unknown }).shape === shape

  return isBoard ? (saved as { value: T }).value : undefined
}

/**
 * What a plugin's store holds, read from its files in the Claude Code configuration directory, so it includes what
 * other sessions wrote. Each install of a plugin keeps a file of its own, and the marketplace install answers before
 * a development copy.
 */
export async function storedValues($: EngineInterface, plugin: string): Promise<Record<string, unknown>> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
  const dir = `${config}/plugins/store`
  if (!(await $.fs.exists(dir))) return {}
  const files = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.startsWith(`${plugin}_`) && f.name.endsWith('.json'))
    .sort((a, b) => Number(b.name.includes('_inline-')) - Number(a.name.includes('_inline-')))
  let out: Record<string, unknown> = {}
  for (const f of files) out = { ...out, ...(JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as Record<string, unknown>) }

  return out
}

/** What another plugin's store holds under `key`. */
export async function legacyValue($: EngineInterface, plugin: string, key: string): Promise<unknown> {
  return (await storedValues($, plugin))[key]
}

/** A board another session saved under `<prefix>:<session id>`, read from disk. */
export function storedBoard<T>(held: Record<string, unknown>, prefix: string, shape: string, sessionId: string) {
  const saved = held[`${prefix}:${sessionId}`]
  const isBoard = typeof saved === 'object' && saved !== null && (saved as { shape?: unknown }).shape === shape

  return isBoard ? (saved as { value: T }).value : undefined
}
