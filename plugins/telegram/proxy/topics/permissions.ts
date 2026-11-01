import { getTopic } from './state'
import type { PermAnswer } from './state'

// A topic-Claude runs detached, so it cannot answer a permission prompt for
// Bash/WebFetch/etc. Instead its MCP forwards the prompt here (POST
// /permission-request); the proxy posts an approve/deny prompt INTO that
// topic's Telegram thread and remembers request_id -> topic. When the user
// answers (inline button or a "yes <id>" / "no <id>" text reply), the proxy
// routes {request_id, behavior} back to the ORIGIN topic's /permission-poll,
// and the MCP fires notifications/claude/channel/permission with it.

export type PendingPerm = { topic: string; createdAt: number }
export const pendingPerms = new Map<string, PendingPerm>() // key = request_id
export const PENDING_PERM_TTL_MS = 60 * 60 * 1000

// Matches "yes <id>" / "no <id>" (also y/n). The <id> is matched loosely; the
// pendingPerms lookup below is the real gate, so conversational "no thanks"
// (token "thanks" is not a pending request) is never intercepted.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+(\S+)\s*$/i

// Drop stale unanswered requests so the map cannot grow unbounded. A pruned
// entry only means a very late reply won't route; the origin session stays
// blocked until answered or restarted (documented behavior).
export function prunePendingPerms(): void {
  const now = Date.now()
  for (const [id, p] of pendingPerms) {
    if (now - p.createdAt > PENDING_PERM_TTL_MS) pendingPerms.delete(id)
  }
}

// Deliver an answer to the topic that ASKED (pending.topic), regardless of
// which thread the button/reply came from, and clear the pending entry.
export function resolvePermission(requestId: string, behavior: 'allow' | 'deny'): boolean {
  const pending = pendingPerms.get(requestId)
  if (!pending) return false
  pendingPerms.delete(requestId)
  const st = getTopic(pending.topic)
  const answer: PermAnswer = { request_id: requestId, behavior }
  const waiter = st.permWaiters.shift()
  if (waiter) waiter(answer)
  else st.permQueue.push(answer)
  return true
}
