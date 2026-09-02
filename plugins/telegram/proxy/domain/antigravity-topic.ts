import type { InboundMessage } from './inbound-delivery'

export type AntigravityEffort = 'low' | 'medium' | 'high'

export type AntigravityModel = {
  id: string
  label: string
  variants: Partial<Record<AntigravityEffort, string>>
  efforts: readonly AntigravityEffort[]
  defaultEffort: AntigravityEffort
}

export type AntigravityRoute = {
  model: string
  modelLabel: string
  modelVariant: string
  effort: AntigravityEffort
}

export type AntigravityTopic = {
  harness: 'antigravity'
  topic: string
  name: string
  route: AntigravityRoute
  conversationId?: string
  createdAt: number
  updatedAt: number
}

export interface AntigravityTopicRepository {
  list(): AntigravityTopic[]
  get(topic: string): AntigravityTopic | undefined
  save(topic: AntigravityTopic): void
}

export function selectAntigravityVariant(
  model: AntigravityModel,
  effort: AntigravityEffort,
): string {
  if (!model.efforts.includes(effort)) {
    throw new Error(`unsupported Antigravity effort ${effort} for ${model.id}`)
  }
  return model.variants[effort] ?? model.id
}

export function antigravityRoute(
  model: AntigravityModel,
  effort: AntigravityEffort,
): AntigravityRoute {
  return {
    model: model.id,
    modelLabel: model.label,
    modelVariant: selectAntigravityVariant(model, effort),
    effort,
  }
}

export function antigravityTopic(
  topic: string,
  name: string,
  route: AntigravityRoute,
  now = Date.now(),
): AntigravityTopic {
  if (!topic.trim()) throw new Error('Antigravity topic id is required')
  return {
    harness: 'antigravity',
    topic,
    name: name.trim() || topic,
    route,
    createdAt: now,
    updatedAt: now,
  }
}

export function antigravityTopicFromRecord(value: unknown): AntigravityTopic | undefined {
  const raw = value as any
  if (!raw || raw.harness !== 'antigravity') return undefined
  if (typeof raw.topic !== 'string' || typeof raw.name !== 'string') return undefined
  if (!raw.route || typeof raw.route !== 'object') return undefined
  const effort = raw.route.effort as AntigravityEffort
  if (!['low', 'medium', 'high'].includes(effort)) return undefined
  for (const field of ['model', 'modelLabel', 'modelVariant']) {
    if (typeof raw.route[field] !== 'string' || !raw.route[field].trim()) return undefined
  }
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return undefined
  if (raw.conversationId !== undefined && typeof raw.conversationId !== 'string') return undefined
  return structuredClone(raw) as AntigravityTopic
}

export function withAntigravityConversation(
  topic: AntigravityTopic,
  conversationId: string,
  now = Date.now(),
): AntigravityTopic {
  if (!conversationId.trim()) throw new Error('Antigravity conversation id is required')
  return { ...topic, conversationId, updatedAt: now }
}

export function withAntigravityRoute(
  topic: AntigravityTopic,
  route: AntigravityRoute,
  now = Date.now(),
): AntigravityTopic {
  return { ...topic, route, updatedAt: now }
}

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

const COMPATIBILITY_CONTEXT = `SYSTEM CONTEXT — Telegram Antigravity pilot

This is one continuous Google Antigravity CLI conversation driven by a Telegram
forum topic. The driver posts your final response back to that same topic.
Do not call a Claude Telegram reply tool; simply return the user-facing response
as your final answer. Keep working autonomously until the requested outcome is
complete, and ask a concise question only when progress genuinely requires it.

Configuration interoperability:
- AGENTS.md and GEMINI.md are native Antigravity project instructions. Discover
  and obey the applicable files for every directory you work in.
- CLAUDE.md is compatibility guidance. On the first task in a project, and when
  the target project changes, locate and read the applicable project CLAUDE.md
  files as supplemental instructions. Also consult ~/.claude/CLAUDE.md when its
  general machine/workflow guidance is relevant. Ignore or translate clauses
  that specifically depend on the Claude Code harness, Claude Channels,
  Claude-only hooks, or Claude-only permission UI; this driver owns Telegram
  delivery and launches Antigravity with non-interactive permissions.
- Skills may be read from ~/.agents/skills, ~/.claude/skills, workspace
  .agents/skills, and native Antigravity skill directories. When a task names a
  skill or clearly matches one, read its complete SKILL.md before acting. A
  Markdown skill is portable; a Claude plugin manifest, hook, or custom agent is
  not automatically executable in Antigravity unless separately adapted.
`

export function renderAntigravityTurn(message: InboundMessage, firstTurn: boolean): string {
  const meta = Object.entries(message.meta)
    .map(([key, value]) => ` ${key}="${attribute(String(value))}"`)
    .join('')
  const channel = `<channel source="telegram"${meta}>\n${message.content}\n</channel>`
  return firstTurn ? `${COMPATIBILITY_CONTEXT}\n${channel}` : channel
}
