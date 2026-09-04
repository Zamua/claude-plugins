export type TopicHarness = 'claude' | 'antigravity' | 'opencode'

export function topicHarness(record: { harness?: unknown }): TopicHarness {
  if (record.harness === 'antigravity') return 'antigravity'
  if (record.harness === 'opencode') return 'opencode'
  return 'claude'
}

export function callbackBelongsToHarness(harness: TopicHarness, data: string): boolean {
  if (data.startsWith('agroute:')) return harness === 'antigravity'
  if (data.startsWith('tgroute:')) return harness === 'claude'
  return true
}

export function callbackTopicTarget(data: string): string | undefined {
  const patterns = [
    /^tgroute:return:[aco]:(.+)$/,
    /^tgroute:p:[aco]:[mqr]:(.+)$/,
    /^tgroute:models:[aco]:[mqr]:([^:]+):\d+$/,
    /^tgroute:providers:[mqr]:(.+)$/,
    /^tgroute:usage:(.+)$/,
    /^agroute:models:([^:]+):\d+$/,
    /^agroute:usage:(.+)$/,
  ]
  for (const pattern of patterns) {
    const match = data.match(pattern)
    if (match) return match[1]
  }
  return undefined
}
