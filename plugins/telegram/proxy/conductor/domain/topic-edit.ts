// What the app may change about a topic: its name (Telegram's limit), and the
// app's own pin and mute.
export const NAME_MAX = 128

export type TopicPatch = { name?: string; pinned?: boolean; muted?: boolean }
export type EditRefusal = { code: string; message: string }

export function topicName(value: unknown): string | EditRefusal {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || [...name].length > NAME_MAX) return { code: 'bad_name', message: `name must be 1 to ${NAME_MAX} characters` }
  return name
}

/** The fields a PATCH names; at least one, each of its own type. */
export function topicPatch(body: Record<string, unknown>): TopicPatch | EditRefusal {
  const patch: TopicPatch = {}
  if ('name' in body) {
    const name = topicName(body.name)
    if (typeof name !== 'string') return name
    patch.name = name
  }
  for (const key of ['pinned', 'muted'] as const) {
    if (!(key in body)) continue
    if (typeof body[key] !== 'boolean') return { code: `bad_${key}`, message: `${key} must be true or false` }
    patch[key] = body[key] as boolean
  }
  return Object.keys(patch).length ? patch : { code: 'empty', message: 'name, pinned or muted' }
}
