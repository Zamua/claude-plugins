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
 * What another plugin's store holds under `key`, read from its file in the Claude Code configuration directory. Each
 * install of a plugin keeps a file of its own, so the marketplace install answers before a development copy.
 */
export async function legacyValue($: EngineInterface, plugin: string, key: string): Promise<unknown> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
  const dir = `${config}/plugins/store`
  if (!(await $.fs.exists(dir))) return undefined
  const files = (await $.fs.list(dir))
    .filter(f => f.kind === 'file' && f.name.startsWith(`${plugin}_`) && f.name.endsWith('.json'))
    .sort((a, b) => Number(a.name.includes('_inline-')) - Number(b.name.includes('_inline-')))
  for (const f of files) {
    const held = JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as Record<string, unknown>
    if (key in held) return held[key]
  }

  return undefined
}
