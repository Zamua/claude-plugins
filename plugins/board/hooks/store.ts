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
