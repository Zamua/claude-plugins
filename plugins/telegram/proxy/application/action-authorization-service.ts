import {
  actionFingerprint,
  approvalDecisionFromText,
  approvalTurn,
  attachAuthorizationPrompt,
  createActionAuthorization,
  decideActionAuthorization,
  expireActionAuthorization,
  markAuthorizationDelivered,
  markReviewerDeniedAfterApproval,
  pendingAuthorizationForReply,
} from '../domain/action-authorization'
import type {
  ActionAuthorization,
  ActionAuthorizationRepository,
  AuthorizationDecision,
} from '../domain/action-authorization'

export type DeniedAction = {
  id: string
  topic: string
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  reason: string
  now: number
}

export type DenialRequestResult = {
  kind: 'created' | 'existing' | 'reviewer-denied'
  request: ActionAuthorization
}

export type AuthorizationResolution =
  | { kind: 'denied'; request: ActionAuthorization }
  | { kind: 'approval-turn'; request: ActionAuthorization; turn: string }

export type NaturalAuthorizationDecision = {
  request: ActionAuthorization
  decision: AuthorizationDecision
}

export interface AuthorizationTurnPort {
  deliver(request: ActionAuthorization, turn: string): void
}

const NOOP_TURN_PORT: AuthorizationTurnPort = { deliver() {} }

export class ActionAuthorizationService {
  private readonly ttlMs: number
  private readonly turnPort: AuthorizationTurnPort

  constructor(
    private readonly repository: ActionAuthorizationRepository,
    options: { ttlMs?: number; turnPort?: AuthorizationTurnPort } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 15 * 60_000
    this.turnPort = options.turnPort ?? NOOP_TURN_PORT
  }

  list(): ActionAuthorization[] {
    return this.repository.list()
  }

  get(id: string): ActionAuthorization | undefined {
    return this.repository.get(id)
  }

  requestForDenial(input: DeniedAction): DenialRequestResult {
    const fingerprint = actionFingerprint(input.toolName, input.toolInput)
    const prior = this.repository.list()
      .filter(request =>
        request.topic === input.topic &&
        request.sessionId === input.sessionId &&
        request.fingerprint === fingerprint,
      )
      .sort((left, right) => right.requestedAt - left.requestedAt)[0]

    if (prior) {
      const current = expireActionAuthorization(prior, input.now)
      if (current.status !== prior.status) this.repository.save(current)
      if (current.status === 'delivered') {
        const rejected = markReviewerDeniedAfterApproval(current, input.now)
        this.repository.save(rejected)
        return { kind: 'reviewer-denied', request: rejected }
      }
      if (current.status === 'pending' || current.status === 'approved' || current.status === 'reviewer-denied') {
        return { kind: 'existing', request: current }
      }
    }

    const request = createActionAuthorization({
      id: input.id,
      topic: input.topic,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      reason: input.reason,
      requestedAt: input.now,
      ttlMs: this.ttlMs,
    })
    this.repository.save(request)
    return { kind: 'created', request }
  }

  attachPrompt(id: string, telegramMessageId: number): ActionAuthorization {
    const request = this.required(id)
    const prompted = attachAuthorizationPrompt(request, telegramMessageId)
    this.repository.save(prompted)
    return prompted
  }

  requestForNaturalReply(
    topic: string,
    sessionId: string,
    text: string,
    replyToMessageId: number | undefined,
    now: number,
  ): NaturalAuthorizationDecision | null {
    const decision = approvalDecisionFromText(text)
    if (!decision) return null
    this.expirePending(now)
    const request = pendingAuthorizationForReply(
      this.repository.list(),
      topic,
      sessionId,
      replyToMessageId,
      now,
    )
    return request ? { request, decision } : null
  }

  resolve(id: string, decision: AuthorizationDecision, now: number): AuthorizationResolution {
    const decided = decideActionAuthorization(this.required(id), decision, now)
    this.repository.save(decided)
    if (decision === 'denied') return { kind: 'denied', request: decided }

    const turn = approvalTurn(decided)
    this.turnPort.deliver(decided, turn)
    const delivered = markAuthorizationDelivered(decided, now)
    this.repository.save(delivered)
    return { kind: 'approval-turn', request: delivered, turn }
  }

  replayApproved(now: number): ActionAuthorization[] {
    const delivered: ActionAuthorization[] = []
    for (const request of this.repository.list()) {
      if (request.status !== 'approved') continue
      const turn = approvalTurn(request)
      this.turnPort.deliver(request, turn)
      const current = markAuthorizationDelivered(request, now)
      this.repository.save(current)
      delivered.push(current)
    }
    return delivered
  }

  expirePending(now: number): void {
    for (const request of this.repository.list()) {
      const current = expireActionAuthorization(request, now)
      if (current.status !== request.status) this.repository.save(current)
    }
  }

  prune(now: number, retentionMs = 24 * 60 * 60_000): number {
    this.expirePending(now)
    let removed = 0
    for (const request of this.repository.list()) {
      if (request.status === 'pending' || request.status === 'approved') continue
      const completedAt = request.deliveredAt ?? request.decidedAt ?? request.expiresAt
      if (now - completedAt < retentionMs) continue
      this.repository.remove(request.id)
      removed += 1
    }
    return removed
  }

  private required(id: string): ActionAuthorization {
    const request = this.repository.get(id)
    if (!request) throw new Error(`authorization ${id} was not found`)
    return request
  }
}
