import { createHash } from 'crypto'

export type AuthorizationDecision = 'approved' | 'denied'
export type AuthorizationStatus =
  | 'pending'
  | AuthorizationDecision
  | 'expired'
  | 'delivered'
  | 'reviewer-denied'

export type ActionAuthorization = {
  version: 1
  id: string
  topic: string
  sessionId: string
  toolName: string
  fingerprint: string
  summary: string
  details: string
  reason: string
  requestedAt: number
  expiresAt: number
  status: AuthorizationStatus
  telegramMessageId?: number
  decidedAt?: number
  deliveredAt?: number
}

export type CreateActionAuthorization = {
  id: string
  topic: string
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  reason: string
  requestedAt: number
  ttlMs: number
}

export interface ActionAuthorizationRepository {
  list(): ActionAuthorization[]
  get(id: string): ActionAuthorization | undefined
  save(request: ActionAuthorization): void
  remove(id: string): void
}

const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|credential|cookie)/i
const PRESENTATION_KEYS = new Set(['description', 'timeout', 'run_in_background'])

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !PRESENTATION_KEYS.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    )
  }
  return value
}

/** Exact enough for one-shot authorization while ignoring Bash UI metadata. */
export function actionFingerprint(toolName: string, toolInput: Record<string, unknown>): string {
  const securityInput = toolName === 'Bash'
    ? { command: String(toolInput.command ?? '') }
    : stableValue(toolInput)
  return createHash('sha256')
    .update(JSON.stringify([toolName, securityInput]))
    .digest('hex')
}

function redactCommand(command: string): string {
  return command
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH|CREDENTIAL|COOKIE)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /(Authorization:\s*(?:Bearer|Basic)\s+)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(--(?:api[-_]?key|token|password|passwd|secret|credential)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]',
    )
}

function redactValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(child => redactValue(child))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, redactValue(child, childKey)]),
    )
  }
  return value
}

export function actionPreview(
  toolName: string,
  toolInput: Record<string, unknown>,
): { summary: string; details: string } {
  const described = typeof toolInput.description === 'string' ? toolInput.description.trim() : ''
  const safeDescription = redactCommand(described)
  const summary = (safeDescription || `Use ${toolName}`).slice(0, 200)
  const rawDetails = toolName === 'Bash' && typeof toolInput.command === 'string'
    ? redactCommand(toolInput.command)
    : JSON.stringify(redactValue(toolInput), null, 2)
  const details = rawDetails.length > 700 ? `${rawDetails.slice(0, 699)}…` : rawDetails
  return { summary, details }
}

export function createActionAuthorization(input: CreateActionAuthorization): ActionAuthorization {
  const preview = actionPreview(input.toolName, input.toolInput)
  return {
    version: 1,
    id: input.id,
    topic: input.topic,
    sessionId: input.sessionId,
    toolName: input.toolName,
    fingerprint: actionFingerprint(input.toolName, input.toolInput),
    summary: preview.summary,
    details: preview.details,
    reason: redactCommand(input.reason).slice(0, 500),
    requestedAt: input.requestedAt,
    expiresAt: input.requestedAt + input.ttlMs,
    status: 'pending',
  }
}

export function expireActionAuthorization(
  request: ActionAuthorization,
  now: number,
): ActionAuthorization {
  if (request.status !== 'pending' || now < request.expiresAt) return request
  return { ...request, status: 'expired', decidedAt: now }
}

export function decideActionAuthorization(
  request: ActionAuthorization,
  decision: AuthorizationDecision,
  now: number,
): ActionAuthorization {
  const current = expireActionAuthorization(request, now)
  if (current.status !== 'pending') {
    throw new Error(`authorization ${request.id} is already ${current.status}`)
  }
  return { ...current, status: decision, decidedAt: now }
}

export function attachAuthorizationPrompt(
  request: ActionAuthorization,
  telegramMessageId: number,
): ActionAuthorization {
  if (request.status !== 'pending') throw new Error(`authorization ${request.id} is not pending`)
  return { ...request, telegramMessageId }
}

export function markAuthorizationDelivered(
  request: ActionAuthorization,
  now: number,
): ActionAuthorization {
  if (request.status !== 'approved') throw new Error(`authorization ${request.id} is not approved`)
  return { ...request, status: 'delivered', deliveredAt: now }
}

export function markReviewerDeniedAfterApproval(
  request: ActionAuthorization,
  now: number,
): ActionAuthorization {
  if (request.status !== 'delivered') {
    throw new Error(`authorization ${request.id} was not delivered`)
  }
  return { ...request, status: 'reviewer-denied', decidedAt: now }
}

export function approvalDecisionFromText(text: string): AuthorizationDecision | null {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, '')
  if (/^(?:y|yes|approve|approved|allow|proceed|do it)(?:[,.]?\s+(?:please\s+)?(?:do it|proceed|continue))?$/.test(normalized)) {
    return 'approved'
  }
  if (/^(?:n|no|deny|denied|cancel|stop)(?:[,.]?\s+(?:it|that))?$/.test(normalized)) {
    return 'denied'
  }
  return null
}

export function pendingAuthorizationForReply(
  requests: ActionAuthorization[],
  topic: string,
  sessionId: string,
  replyToMessageId: number | undefined,
  now: number,
): ActionAuthorization | null {
  const pending = requests
    .map(request => expireActionAuthorization(request, now))
    .filter(request =>
      request.topic === topic &&
      request.sessionId === sessionId &&
      request.status === 'pending',
    )
  if (replyToMessageId != null) {
    return pending.find(request => request.telegramMessageId === replyToMessageId) ?? null
  }
  return pending.length === 1 ? pending[0] : null
}

export function approvalTurn(request: ActionAuthorization): string {
  return [
    'I explicitly approve this exact action once:',
    '',
    request.summary,
    '',
    `Tool: ${request.toolName}`,
    `Exact invocation (sensitive values redacted): ${request.details}`,
    `Authorization request: ${request.id}`,
    `Action fingerprint: ${request.fingerprint.slice(0, 12)}`,
    '',
    'Please retry only this exact action without expanding its scope. The normal auto-mode reviewer should evaluate it again with this explicit authorization. If crash recovery repeats this same authorization request ID, do not retry it twice.',
  ].join('\n')
}
