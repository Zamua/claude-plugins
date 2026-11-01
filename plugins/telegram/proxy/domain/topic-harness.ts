export type TopicHarness = 'claude' | 'antigravity' | 'opencode' | 'localgen'

export function topicHarness(record: { harness?: unknown }): TopicHarness {
  if (record.harness === 'antigravity') return 'antigravity'
  if (record.harness === 'opencode') return 'opencode'
  if (record.harness === 'localgen') return 'localgen'
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

export type LockedHarness = Exclude<TopicHarness, 'claude'>

const LOCK_COMMAND: Record<LockedHarness, string> = {
  antigravity: '/antigravity',
  opencode: '/localcode',
  localgen: '/localgen',
}
const RUNTIME_LABEL: Record<LockedHarness, string> = {
  antigravity: 'Google / Antigravity',
  opencode: 'OpenCode / local Qwen',
  localgen: 'localgen',
}
const SHORT_LABEL: Record<LockedHarness, string> = {
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  localgen: 'localgen',
}

export type LockRequest = {
  harness: LockedHarness
  byOperator: boolean
  inSquare: boolean
  current: TopicHarness
  ownsClaudeConversation: boolean
}

// Why a topic cannot be locked to `harness`, or undefined when it can. A topic
// already locked to that same harness is not refused: each harness answers it.
export function lockRefusal(r: LockRequest): string | undefined {
  if (!r.byOperator) return `Only the operator can lock a topic to ${SHORT_LABEL[r.harness]}.`
  if (r.inSquare) return 'The square cannot be assigned an agent harness.'
  if (r.current === r.harness) return undefined
  const fresh = `Create a fresh topic and run ${LOCK_COMMAND[r.harness]} there.`
  if (r.current !== 'claude') return `This topic is locked to ${RUNTIME_LABEL[r.current]}. ${fresh}`
  if (r.ownsClaudeConversation) {
    return `This topic already owns a Claude Code conversation, so it cannot be converted in place. ${fresh}`
  }
  return undefined
}
