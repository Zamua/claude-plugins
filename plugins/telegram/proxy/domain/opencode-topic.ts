import type { InboundMessage } from './inbound-delivery'

export type OpencodeTopic = {
  harness: 'opencode'
  topic: string
  name: string
  sessionName?: string
  opencodeSessionId?: string
  restartPending?: boolean
  createdAt: number
  updatedAt: number
}

export interface OpencodeTopicRepository {
  list(): OpencodeTopic[]
  get(topic: string): OpencodeTopic | undefined
  save(topic: OpencodeTopic): void
}

export function opencodeTopic(
  topic: string,
  name: string,
  now = Date.now(),
): OpencodeTopic {
  if (!topic.trim()) throw new Error('OpenCode topic id is required')
  return {
    harness: 'opencode',
    topic,
    name: name.trim() || topic,
    createdAt: now,
    updatedAt: now,
  }
}

export function opencodeTopicFromRecord(value: unknown): OpencodeTopic | undefined {
  const raw = value as any
  if (!raw || raw.harness !== 'opencode') return undefined
  if (typeof raw.topic !== 'string' || typeof raw.name !== 'string') return undefined
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return undefined
  if (raw.sessionName !== undefined && typeof raw.sessionName !== 'string') return undefined
  if (raw.opencodeSessionId !== undefined && typeof raw.opencodeSessionId !== 'string') return undefined
  if (raw.restartPending !== undefined && typeof raw.restartPending !== 'boolean') return undefined
  return structuredClone(raw) as OpencodeTopic
}

export function withOpencodeSession(
  topic: OpencodeTopic,
  sessionName: string,
  opencodeSessionId: string,
  now = Date.now(),
): OpencodeTopic {
  if (!sessionName.trim()) throw new Error('OpenCode session name is required')
  if (!opencodeSessionId.trim()) throw new Error('OpenCode session id is required')
  return { ...topic, sessionName, opencodeSessionId, updatedAt: now }
}

export function requestOpencodeRestart(
  topic: OpencodeTopic,
  now = Date.now(),
): OpencodeTopic {
  return { ...topic, restartPending: true, updatedAt: now }
}

export function applyOpencodePending(
  topic: OpencodeTopic,
  now = Date.now(),
): OpencodeTopic {
  const { restartPending: _restartPending, ...rest } = topic
  return { ...rest, updatedAt: now }
}

export function opencodeSessionName(topic: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'topic'
  return `oc-${slug}-${topic}`
}

function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

const COMPATIBILITY_CONTEXT = `SYSTEM CONTEXT: Telegram OpenCode session

This is one continuous OpenCode session on the local Qwen model, driven by a
Telegram forum topic and hosted in a persistent Herdr workspace. The operator
can monitor and interact with this terminal directly. For every
<channel source="telegram"> turn, the user-facing answer MUST be sent with the
Telegram MCP tool telegram-topics_reply using chat_id from the channel
metadata. Terminal output alone never reaches Telegram. A prompt typed directly
into the terminal is answered only in the terminal; do not send it to Telegram
unless explicitly asked.

When the channel metadata carries image_path or attachment_path, those name
local files: Read them before answering.

Keep answers concise. The model behind this session is a local 27B; short,
direct replies work best.

Configuration interoperability:
- Project instructions (AGENTS.md) and ~/.claude/CLAUDE.md load natively. Obey
  them. Translate any clause that depends on the Claude Code harness (Claude
  Channels, hooks, permission UI) into "reply through the Telegram MCP".
`

export function renderOpencodeKickoff(): string {
  return `${COMPATIBILITY_CONTEXT}\nAcknowledge this setup in the terminal only, then wait for the first Telegram or terminal prompt.`
}

export function renderOpencodeTurn(message: InboundMessage): string {
  const meta = Object.entries(message.meta)
    .map(([key, value]) => ` ${key}="${attribute(String(value))}"`)
    .join('')
  return `<channel source="telegram"${meta}>\n${message.content}\n</channel>\n\n` +
    'Reply to this Telegram turn with the Telegram MCP tool telegram-topics_reply using the chat_id above. ' +
    'Do not leave the user-facing answer only in the terminal.'
}
