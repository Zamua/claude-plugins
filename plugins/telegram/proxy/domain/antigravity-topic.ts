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
  sessionName?: string
  pendingRoute?: AntigravityRoute
  restartPending?: boolean
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
  if (raw.sessionName !== undefined && typeof raw.sessionName !== 'string') return undefined
  if (raw.pendingRoute !== undefined && !validRoute(raw.pendingRoute)) return undefined
  if (raw.restartPending !== undefined && typeof raw.restartPending !== 'boolean') return undefined
  return structuredClone(raw) as AntigravityTopic
}

function validRoute(value: unknown): value is AntigravityRoute {
  const route = value as any
  return !!route && typeof route === 'object' &&
    ['low', 'medium', 'high'].includes(route.effort) &&
    ['model', 'modelLabel', 'modelVariant'].every(
      field => typeof route[field] === 'string' && route[field].trim(),
    )
}

export function withAntigravityConversation(
  topic: AntigravityTopic,
  conversationId: string,
  now = Date.now(),
): AntigravityTopic {
  if (!conversationId.trim()) throw new Error('Antigravity conversation id is required')
  return { ...topic, conversationId, updatedAt: now }
}

export function withAntigravitySession(
  topic: AntigravityTopic,
  sessionName: string,
  conversationId: string,
  now = Date.now(),
): AntigravityTopic {
  if (!sessionName.trim()) throw new Error('Antigravity session name is required')
  return {
    ...withAntigravityConversation(topic, conversationId, now),
    sessionName,
  }
}

export function requestAntigravityRoute(
  topic: AntigravityTopic,
  route: AntigravityRoute,
  now = Date.now(),
): AntigravityTopic {
  return { ...topic, pendingRoute: route, updatedAt: now }
}

export function requestAntigravityRestart(
  topic: AntigravityTopic,
  now = Date.now(),
): AntigravityTopic {
  return { ...topic, restartPending: true, updatedAt: now }
}

export function applyAntigravityPending(
  topic: AntigravityTopic,
  now = Date.now(),
): AntigravityTopic {
  const { pendingRoute, restartPending: _restartPending, ...rest } = topic
  return {
    ...rest,
    route: pendingRoute ?? topic.route,
    updatedAt: now,
  }
}

export function antigravitySessionName(topic: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'topic'
  return `agy-${slug}-${topic}`
}

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

const COMPATIBILITY_CONTEXT = `SYSTEM CONTEXT — Telegram Antigravity session

This is one continuous Google Antigravity CLI conversation driven by a Telegram
forum topic and hosted in a persistent Herdr workspace. The operator can monitor
and interact with this terminal directly. For every <channel source="telegram">
turn, anything the sender should see MUST be sent with the Telegram MCP reply
tool using chat_id from the channel metadata. Terminal output alone never reaches
Telegram. For an ordinary prompt typed directly into Herdr, respond normally in
the terminal and do not send it to Telegram unless explicitly asked.

Keep working autonomously until the requested outcome is complete, and ask a
concise question only when progress genuinely requires it.

Configuration interoperability:
- AGENTS.md and GEMINI.md are native Antigravity project instructions. Discover
  and obey the applicable files for every directory you work in.
- CLAUDE.md is compatibility guidance. On the first task in a project, and when
  the target project changes, locate and read the applicable project CLAUDE.md
  files as supplemental instructions. Also consult ~/.claude/CLAUDE.md when its
  general machine/workflow guidance is relevant. Ignore or translate clauses
  that specifically depend on the Claude Code harness, Claude Channels,
  Claude-only hooks, or Claude-only permission UI. This session uses the
  outbound-only Telegram MCP and Antigravity's non-interactive permissions.
- Skills may be read from ~/.agents/skills, ~/.claude/skills, workspace
  .agents/skills, and native Antigravity skill directories. When a task names a
  skill or clearly matches one, read its complete SKILL.md before acting. A
  Markdown skill is portable; a Claude plugin manifest, hook, or custom agent is
  not automatically executable in Antigravity unless separately adapted.
`

export function renderAntigravityKickoff(): string {
  return `${COMPATIBILITY_CONTEXT}\nAcknowledge this setup in the terminal only, then wait for the first Telegram or Herdr prompt.`
}

export function renderAntigravityTurn(message: InboundMessage): string {
  const meta = Object.entries(message.meta)
    .map(([key, value]) => ` ${key}="${attribute(String(value))}"`)
    .join('')
  return `<channel source="telegram"${meta}>\n${message.content}\n</channel>\n\n` +
    'Reply to this Telegram turn through the Telegram MCP reply tool using the chat_id above. ' +
    'Do not leave the user-facing answer only in the terminal.'
}
