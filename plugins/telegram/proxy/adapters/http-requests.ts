// Request bodies of the proxy's HTTP API, checked where they enter. A malformed
// body is a 400 naming the field, never a NaN id or a phantom topic downstream.
import type { TopicHarness } from '../domain/topic-harness'

export class BadRequest extends Error {}

type Body = Record<string, unknown>

function object(body: unknown): Body {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequest('body must be a JSON object')
  }
  return body as Body
}

function text(b: Body, field: string, fallback?: string): string {
  const value = b[field]
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    throw new BadRequest(`${field} required`)
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new BadRequest(`${field} must be a string`)
  return String(value)
}

function integer(b: Body, field: string): number {
  const n = Number(text(b, field))
  if (!Number.isSafeInteger(n)) throw new BadRequest(`${field} must be an integer`)
  return n
}

// For fields whose absence or garbage has a defined fallback.
function optionalNumber(b: Body, field: string): number | undefined {
  const n = Number(b[field])
  return b[field] != null && Number.isFinite(n) ? n : undefined
}

// A forum topic key: "general" or a thread id. Anything else would become a
// topic with a NaN thread id.
function topicKey(b: Body, fallback?: string): string {
  const topic = text(b, 'topic', fallback)
  if (topic !== 'general' && !/^\d+$/.test(topic)) throw new BadRequest(`topic must be "general" or a thread id`)
  return topic
}

const markdown = (b: Body) => b.format === 'markdownv2'

export type SendRequest = {
  chatId: string
  topic: string
  text: string
  replyTo?: number
  files: string[]
  markdown: boolean
}

export function parseSend(body: unknown): SendRequest {
  const b = object(body)
  const files = b.files ?? []
  if (!Array.isArray(files) || !files.every(f => typeof f === 'string')) {
    throw new BadRequest('files must be a list of paths')
  }
  return {
    chatId: text(b, 'chat_id'),
    topic: topicKey(b, 'general'),
    text: text(b, 'text', ''),
    ...(b.reply_to != null ? { replyTo: integer(b, 'reply_to') } : {}),
    files,
    markdown: markdown(b),
  }
}

export type ReactRequest = { chatId: string; messageId: number; emoji: string }

export function parseReact(body: unknown): ReactRequest {
  const b = object(body)
  return { chatId: text(b, 'chat_id'), messageId: integer(b, 'message_id'), emoji: text(b, 'emoji') }
}

export type EditRequest = { chatId: string; messageId: number; text: string; markdown: boolean }

export function parseEdit(body: unknown): EditRequest {
  const b = object(body)
  return {
    chatId: text(b, 'chat_id'),
    messageId: integer(b, 'message_id'),
    text: text(b, 'text'),
    markdown: markdown(b),
  }
}

export function parseDownload(body: unknown): { fileId: string } {
  return { fileId: text(object(body), 'file_id') }
}

export type PermissionRequestBody = { topic: string; requestId: string; tool: string; input: string }

export function parsePermissionRequest(body: unknown): PermissionRequestBody {
  const b = object(body)
  const requestId = text(b, 'request_id')
  if (!requestId) throw new BadRequest('request_id required')
  return { topic: topicKey(b, 'general'), requestId, tool: text(b, 'tool', 'tool'), input: text(b, 'input', '') }
}

export type TopicCreateRequest = { name: string; harness: TopicHarness }

export function parseTopicCreate(body: unknown): TopicCreateRequest {
  const b = object(body)
  const name = text(b, 'name', '').trim()
  if (!name) throw new BadRequest('name required')
  const harness = text(b, 'harness', 'claude')
  if (harness !== 'claude' && harness !== 'antigravity' && harness !== 'opencode' && harness !== 'localgen') {
    throw new BadRequest('harness must be claude, antigravity, opencode, or localgen')
  }
  return { name, harness }
}

export function parseCancelReminder(body: unknown): { topic: string; id: string } {
  const b = object(body)
  return { topic: topicKey(b), id: text(b, 'id') }
}

export type TurnFailedRequest = { topic: string; error: string; details: string }

export function parseTurnFailed(body: unknown): TurnFailedRequest {
  const b = object(body)
  return { topic: topicKey(b), error: text(b, 'error', 'unknown').slice(0, 40), details: text(b, 'details', '') }
}

/** `resetAt` is epoch seconds when the hook could read one from the error. */
export function parseRateLimit(body: unknown): { topic: string; resetAt?: number } {
  const b = object(body)
  const resetAt = optionalNumber(b, 'reset_at')
  return { topic: topicKey(b), ...(resetAt !== undefined ? { resetAt } : {}) }
}

// The caller of a square call may be a topic or a virtual caller ("operator").
export type SquareTagRequest = { caller: string; peer: string; text: string }

export function parseSquareTag(body: unknown): SquareTagRequest {
  const b = object(body)
  return { caller: text(b, 'topic', ''), peer: text(b, 'peer', ''), text: text(b, 'text', '').trim() }
}

/** A missing or garbled `replyToken` threads the reply to the conversation root. */
export type SquareReplyRequest = { caller: string; conv: string; text: string; replyToken?: number }

export function parseSquareReply(body: unknown): SquareReplyRequest {
  const b = object(body)
  const token = optionalNumber(b, 'reply_token')
  return {
    caller: text(b, 'topic', ''),
    conv: text(b, 'conv', ''),
    text: text(b, 'text', '').trim(),
    ...(token !== undefined && token > 0 ? { replyToken: token } : {}),
  }
}
