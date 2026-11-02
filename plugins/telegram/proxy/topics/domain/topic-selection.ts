// Which topics a setting names: a comma list of thread ids and `general`, or
// `*` for every topic, including ones created later.

export type TopicSelection = {
  has(topic: string): boolean
  /** Whether it names any topic at all. */
  readonly any: boolean
}

export function topicSelection(raw: string, warn: (message: string) => void): TopicSelection {
  const named = new Set<string>()
  let every = false
  for (const t of raw.split(',').map(t => t.trim()).filter(Boolean)) {
    if (t === '*') every = true
    else if (t === 'general' || /^\d+$/.test(t)) named.add(t)
    else warn(`"${t}" is neither a thread id, general, nor *; ignored`)
  }
  return { has: topic => every || named.has(topic), any: every || named.size > 0 }
}
