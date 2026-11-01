// The conductor's objects as the API sends them: docs/conductor.md, with the
// golden fixtures in docs/conductor-v1/ as the exact shapes.
import type { StoredMessage } from './domain/message'

export type AgentState = 'starting' | 'idle' | 'working' | 'blocked' | 'stopped' | 'missing'

export type TopicView = {
  id: string
  name: string
  kind: string
  title: string | null
  pinned: boolean
  muted: boolean
  state: AgentState
  stateSince: string | null
  unread: number
  readSeq: number
  pendingApprovals: number
  route: { provider: string; model: string; effort: string } | null
  lastMessage: { preview: string; author: string; at: string } | null
}

/** hc reports no cursor position, so screens carry none. */
export type ScreenView = { topic: string; rows: string[]; cols: number; working: boolean }

export function wireScreen(s: ScreenView): Record<string, unknown> {
  return { topic: s.topic, rows: s.rows, cols: s.cols, cursor: null, working: s.working }
}

export type Device = {
  id: string
  name: string
  publicKey: string
  nodeId: string
  apnsToken: string | null
  apnsEnv: 'sandbox' | 'production' | null
  enrolledAt: string
  lastSeen: string | null
}

export function wireMessage(m: StoredMessage): Record<string, unknown> {
  const base = {
    id: m.id,
    topic: m.topic,
    seq: m.seq,
    author: m.author,
    origin: m.origin,
    kind: m.kind,
    text: m.text,
    format: m.format,
    blobs: m.blobs.map(b => ({ id: b.id, mime: b.mime, bytes: b.bytes, width: b.width, height: b.height })),
    reply_to: m.replyTo,
    at: m.at,
    edited_at: m.editedAt,
    reactions: m.reactions.map(r => ({ emoji: r.emoji })),
  }
  if (m.author !== 'operator') return base
  // An operator message relayed from Telegram was delivered as it arrived.
  return { ...base, client_id: m.clientId, delivery: m.delivery ?? 'delivered', ...(m.failure !== null ? { failure: m.failure } : {}) }
}

export function wireTopic(t: TopicView): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    title: t.title,
    pinned: t.pinned,
    muted: t.muted,
    state: t.state,
    state_since: t.stateSince,
    unread: t.unread,
    read_seq: t.readSeq,
    pending_approvals: t.pendingApprovals,
    route: t.route,
    last_message: t.lastMessage,
  }
}

/** A device as the API shows it; its node stays on the server. */
export function wireDevice(d: Device): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    public_key: d.publicKey,
    apns_token: d.apnsToken,
    apns_env: d.apnsEnv,
    enrolled_at: d.enrolledAt,
    last_seen: d.lastSeen,
  }
}
