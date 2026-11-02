// Who runs a topic's session: the proxy, or the Crook backend. One field in the
// registry, which both read; it changes only by an explicit owner command, never
// as a side effect of anything else, so the two sides cannot disagree.
export type LifecycleOwner = 'proxy' | 'crook'

/** The answer to a relaunch or route change in a topic the backend runs. */
export const CROOK_OWNED_NOTICE = "This topic's session is run by the Crook backend; relaunch or switch its model there."

export const lifecycleOwnerFrom = (value: unknown): LifecycleOwner => (value === 'crook' ? 'crook' : 'proxy')

export type OwnerFacts = { square: boolean; harnessLocked: boolean; provider: string; conversation: boolean }

/**
 * Why a topic cannot go to `owner`, or nothing when it can. The backend resumes an
 * existing Claude conversation on an Anthropic route and never writes the registry,
 * so a topic with no conversation id yet stays with the proxy until its first start.
 */
export function ownerRefusal(owner: LifecycleOwner, topic: OwnerFacts): string | undefined {
  if (owner === 'proxy') return undefined
  if (topic.square) return 'the square has no session'
  if (topic.harnessLocked) return 'locked to another harness, which only the proxy runs'
  if (!topic.conversation) return 'no conversation yet; the proxy starts it first'
  if (topic.provider !== 'anthropic') return `on a ${topic.provider} route, which the Crook backend cannot run`
  return undefined
}

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type HandBackFacts = { otherTopic?: string; live: boolean; onDisk: boolean }

/**
 * Why a topic handed back cannot resume `conversation`, the backend's newer one, or nothing
 * when it can. Another topic's conversation, or one a live session holds, would get two writers.
 */
export function handBackRefusal(conversation: string, facts: HandBackFacts): string | undefined {
  if (!CONVERSATION_ID.test(conversation)) return 'not a Claude conversation id'
  if (facts.otherTopic) return `the conversation is topic ${facts.otherTopic}'s`
  if (facts.live) return 'a live session holds the conversation; stop it first'
  if (!facts.onDisk) return 'no transcript of that conversation is on disk'
  return undefined
}
