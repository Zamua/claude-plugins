// The conductor's objects as the API sends them: docs/conductor.md, with the
// golden fixtures in docs/conductor-v1/ as the exact shapes.
import { PROVIDERS, providerLabel } from '../routing/domain/model-routing'
import type { ProviderId } from '../routing/domain/model-routing'
import type { ProviderCapacity } from '../routing/domain/provider-capacity'
import type { ProviderCatalog } from '../routing/provider-catalog'
import type { Reminder } from '../reminders/domain/reminder'
import type { SecretEntry } from '../secrets/secret'
import type { Approval } from './domain/approval'
import type { MessageFormat, StoredMessage } from './domain/message'
import { offered } from './domain/route-choice'

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
  lastMessage: { preview: string; format: MessageFormat; author: string; at: string } | null
  role: 'root' | 'coordinator' | 'worker'
  projectId: string | null
  parentId: string | null
  spawnedBy: string | null
  spawnedAt: string | null
  archivedAt: string | null
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
    ...(m.imported ? { imported: true } : {}),
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
    role: t.role,
    project_id: t.projectId,
    parent_id: t.parentId,
    spawned_by: t.spawnedBy,
    spawned_at: t.spawnedAt,
    ...(t.archivedAt ? { archived_at: t.archivedAt } : {}),
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

/** The model catalog as the app picks from it: every provider, the models the bridge can run. */
/** The route catalog; with `operatorOnly`, each provider says whether only the operator may pick it. */
export function wireRoutes(catalog: ProviderCatalog, operatorOnly?: (provider: ProviderId) => boolean): Record<string, unknown> {
  return {
    providers: PROVIDERS.map(id => ({
      id,
      label: providerLabel(id),
      ...(operatorOnly ? { operator_only: operatorOnly(id) } : {}),
      models: offered(catalog, id).map(m => ({ id: m.id, label: m.label, efforts: m.efforts, default_effort: m.defaultEffort })),
    })),
  }
}

/** Quota windows of the providers observed so far. */
export function wireUsage(capacities: readonly ProviderCapacity[]): Record<string, unknown> {
  const order = (c: ProviderCapacity) => PROVIDERS.indexOf(c.provider)
  return {
    providers: [...capacities].sort((a, b) => order(a) - order(b)).map(c => ({
      id: c.provider,
      windows: c.windows.map(w => ({
        name: w.name,
        used_percent: w.usedPercent ?? null,
        resets_at: w.resetsAt ? new Date(w.resetsAt).toISOString() : null,
      })),
    })),
  }
}

export function wireReminder(r: Reminder): Record<string, unknown> {
  return { id: r.id, topic: r.topic, at: r.atText, text: r.text, prompt: r.prompt ?? null, created_at: new Date(r.createdAt).toISOString() }
}

/** Names, sizes and dates: a secret's value never leaves its file. */
export function wireSecrets(entries: readonly SecretEntry[]): Record<string, unknown> {
  return { secrets: entries.map(e => ({ name: e.name, bytes: e.bytes, updated_at: e.mtime.toISOString() })) }
}

export function wireApproval(a: Approval): Record<string, unknown> {
  return { id: a.id, topic: a.topic, kind: a.kind, prompt: a.prompt, choices: a.choices, created_at: a.createdAt, resolved: a.resolved }
}

