// Every topic's in-memory state: its inbound queues, its session, its route.
import type { SessionNode } from './domain/session-tree'
import { DEFAULT_TOPIC_ROUTE, GROUP_CHAT_ID } from '../config'
import type { InboundMessage } from '../shared/domain/inbound-delivery'
import type { TopicRoute } from '../routing/domain/model-routing'
import type { RouteFlow } from '../routing/domain/route-flow'
import { topicSlug } from '../shared/domain/topic-slug'
import type { Agent } from './domain/agent'

export type InboundMsg = InboundMessage
export type PermAnswer = { request_id: string; behavior: 'allow' | 'deny' }

export type TopicState = {
  queue: InboundMsg[]
  waiters: Array<(m: InboundMsg | null) => void>
  /** The message handed to the MCP and not yet acknowledged by its next poll. */
  inflight?: { id: string; item: InboundMsg }
  // Permission answers ride a SEPARATE queue + long-poll (GET /permission-poll)
  // so a Telegram "yes <id>" reply is delivered ONLY to the topic-MCP that
  // asked, never mixed into (or consumed by) the normal channel /poll stream.
  permQueue: PermAnswer[]
  permWaiters: Array<(a: PermAnswer | null) => void>
  threadId?: number // undefined for "general"
  name: string
  agent: Agent
  // The claude session id for this topic, minted on the FIRST spawn (passed via
  // --session-id) and reused via --resume on every later spawn. This is what
  // makes a topic one continuous conversation across kills / crashes / proxy
  // restarts: all topics share one spawn dir, so bare --continue (most-recent
  // session in a dir) cannot tell them apart - we track the id explicitly.
  claudeSessionId?: string
  // The route this topic's Claude runs on, a change waiting for its turn to end,
  // the routes that hit their limits, and the notice a resumed session owes.
  // Every route runs Claude Code; only nextRoute changes it.
  routing: RouteFlow
  /** Where the topic hangs in the session tree, when recorded at its creation. */
  session?: SessionNode
  /** When it was archived: hidden and stopped, its conversation kept, until something wakes it. */
  archivedAt?: string
}

export const topics = new Map<string, TopicState>()
// forum_topic_created names learned before a topic's session is spawned.
export const topicNames = new Map<string, string>()

// The mux session name. Readable: `<prefix>-<slug>-<thread_id>` (e.g.
// `claude-hostthis-34`), with the numeric thread id as a short, stable,
// collision-proof suffix; the General topic (no thread id) is just
// `<prefix>-general`. The prefix doubles as the harness marker
// (`claude-` / `oc-`) so panes are self-describing. Computed from the topic's
// LABEL at spawn time and then RECORDED in the topic's agent (dedup/kill use the
// recorded string, never re-derive) so a later rename can't orphan the
// running session.
export function sessionNameFor(topic: string, label?: string, prefix = 'claude'): string {
  if (topic === 'general') return `${prefix}-general`
  const id = topic.replace(/[^A-Za-z0-9]/g, '')
  const slug = topicSlug(label ?? '')
  // Unknown/degenerate name (the label fell back to the numeric id, or slugified
  // to the 'topic' placeholder) -> just `<prefix>-<id>`, not `<prefix>-<id>-<id>`.
  if (slug === id || slug === 'topic') return `${prefix}-${id}`
  return `${prefix}-${slug}-${id}`
}

// The pre-2026-07 `tg-<cid>-<tid>` name. Used ONLY by the migration bridge in
// ensureSession to ADOPT a still-live old-scheme session (rather than spawning a
// second one under the new name) - the launcher's has-session guard keys off the
// NEW name so it cannot catch an old-named orphan. Removable once no `tg-*`
// sessions remain in the wild.
export function legacySessionNameFor(topic: string): string {
  const cid = String(GROUP_CHAT_ID).replace(/[^0-9]/g, '')
  return `tg-${cid}-${topic.replace(/[^A-Za-z0-9]/g, '') || 'x'}`
}

export function getTopic(topic: string): TopicState {
  let st = topics.get(topic)
  if (!st) {
    st = {
      queue: [],
      waiters: [],
      permQueue: [],
      permWaiters: [],
      threadId: topic === 'general' ? undefined : Number(topic),
      name: '',
      agent: { state: 'stopped' },
      routing: { route: DEFAULT_TOPIC_ROUTE, exhausted: [] },
    }
    topics.set(topic, st)
  }
  return st
}

/** The route a topic's Claude runs on. */
export function currentRoute(st: TopicState): TopicRoute {
  return st.routing.route
}
