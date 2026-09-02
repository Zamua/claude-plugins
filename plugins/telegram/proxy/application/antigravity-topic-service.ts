import {
  antigravitySessionName,
  applyAntigravityPending,
  renderAntigravityKickoff,
  renderAntigravityTurn,
  requestAntigravityRestart,
  requestAntigravityRoute,
  withAntigravitySession,
} from '../domain/antigravity-topic'
import type {
  AntigravityRoute,
  AntigravityTopic,
  AntigravityTopicRepository,
} from '../domain/antigravity-topic'
import type { InboundMessage } from '../domain/inbound-delivery'
import type {
  AntigravityOutboundPort,
  AntigravityRuntimePort,
} from './antigravity-ports'

export type AntigravityChangeResult = {
  topic: AntigravityTopic
  pending: boolean
}

export class AntigravityTopicService {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly repository: AntigravityTopicRepository,
    private readonly runtime: AntigravityRuntimePort,
    private readonly outbound: AntigravityOutboundPort,
    private readonly now: () => number = Date.now,
  ) {}

  list(): AntigravityTopic[] {
    return this.repository.list()
  }

  get(topic: string): AntigravityTopic | undefined {
    return this.repository.get(topic)
  }

  isLocked(topic: string): boolean {
    return this.repository.get(topic)?.harness === 'antigravity'
  }

  activate(topic: AntigravityTopic): AntigravityTopic {
    const existing = this.repository.get(topic.topic)
    if (existing) throw new Error(`topic ${topic.topic} is already Antigravity-managed`)
    this.repository.save(topic)
    return topic
  }

  rename(topicId: string, name: string): AntigravityTopic {
    const current = this.required(topicId)
    const changed = { ...current, name: name.trim() || current.name, updatedAt: this.now() }
    this.repository.save(changed)
    return changed
  }

  models() {
    return this.runtime.models()
  }

  usage() {
    return this.runtime.usage()
  }

  async start(topicId: string): Promise<AntigravityTopic> {
    return this.ensureReady(topicId)
  }

  async requestRoute(topicId: string, route: AntigravityRoute): Promise<AntigravityChangeResult> {
    const requested = requestAntigravityRoute(this.required(topicId), route, this.now())
    this.repository.save(requested)
    return this.applyPendingIfIdle(topicId)
  }

  async requestRelaunch(topicId: string): Promise<AntigravityChangeResult> {
    const requested = requestAntigravityRestart(this.required(topicId), this.now())
    this.repository.save(requested)
    return this.applyPendingIfIdle(topicId)
  }

  async reconcilePending(): Promise<void> {
    for (const topic of this.repository.list()) {
      if (!topic.pendingRoute && !topic.restartPending) continue
      try {
        await this.applyPendingIfIdle(topic.topic)
      } catch (error) {
        await this.reportError(topic.topic, error)
      }
    }
  }

  submitTurn(topicId: string, message: InboundMessage): Promise<void> {
    const prior = this.queues.get(topicId) ?? Promise.resolve()
    const queued = prior.catch(() => {}).then(() => this.executeTurn(topicId, message))
    this.queues.set(topicId, queued)
    const clean = () => {
      if (this.queues.get(topicId) === queued) this.queues.delete(topicId)
    }
    void queued.then(clean, clean)
    return queued
  }

  busy(topicId: string): boolean {
    return this.queues.has(topicId)
  }

  async status(topicId: string) {
    const topic = this.required(topicId)
    return topic.sessionName ? this.runtime.status(topic.sessionName) : 'missing'
  }

  private async executeTurn(topicId: string, message: InboundMessage): Promise<void> {
    try {
      const ready = await this.ensureReady(topicId)
      this.outbound.typing(topicId)
      const typing = setInterval(() => this.outbound.typing(topicId), 4_000)
      try {
        await this.runtime.prompt(ready.sessionName!, renderAntigravityTurn(message))
      } finally {
        clearInterval(typing)
      }
      await this.applyPendingAfterOwnedTurn(topicId)
    } catch (error) {
      await this.reportError(topicId, error)
    }
  }

  private async ensureReady(topicId: string): Promise<AntigravityTopic> {
    const current = this.required(topicId)
    const sessionName = current.sessionName ?? antigravitySessionName(current.topic, current.name)
    const identity = await this.runtime.ensureSession({
      topic: current.topic,
      name: current.name,
      sessionName,
      route: {
        modelVariant: current.route.modelVariant,
        effort: current.route.effort,
      },
      conversationId: current.conversationId,
      kickoff: renderAntigravityKickoff(),
    })
    if (current.conversationId && identity.conversationId !== current.conversationId) {
      await this.runtime.stop(identity.sessionName).catch(() => false)
      throw new Error(
        `Antigravity changed conversation identity from ${current.conversationId} ` +
        `to ${identity.conversationId}; refusing to fork this topic`,
      )
    }
    // A route request may land while the pane is starting. Re-read so saving
    // runtime identity cannot roll pending route state back.
    const latest = this.required(topicId)
    const running = withAntigravitySession(
      latest,
      identity.sessionName,
      identity.conversationId,
      this.now(),
    )
    this.repository.save(running)
    return running
  }

  private async applyPendingIfIdle(topicId: string): Promise<AntigravityChangeResult> {
    const current = this.required(topicId)
    if (!current.pendingRoute && !current.restartPending) return { topic: current, pending: false }
    if (this.busy(topicId)) return { topic: current, pending: true }
    const state = current.sessionName ? await this.runtime.status(current.sessionName) : 'missing'
    if (state === 'busy' || state === 'starting' || state === 'blocked') {
      return { topic: current, pending: true }
    }
    return { topic: await this.applyPendingNow(topicId), pending: false }
  }

  private async applyPendingAfterOwnedTurn(topicId: string): Promise<void> {
    const current = this.required(topicId)
    if (!current.pendingRoute && !current.restartPending) return
    await this.applyPendingNow(topicId)
  }

  private async applyPendingNow(topicId: string): Promise<AntigravityTopic> {
    const current = this.required(topicId)
    if (current.sessionName) await this.runtime.stop(current.sessionName)
    const applied = applyAntigravityPending(current, this.now())
    this.repository.save(applied)
    return this.ensureReady(topicId)
  }

  private async reportError(topicId: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      await this.outbound.error(topicId, `Antigravity could not complete this turn: ${detail}`)
    } catch {}
  }

  private required(topic: string): AntigravityTopic {
    const current = this.repository.get(topic)
    if (!current) throw new Error(`topic ${topic} is not an Antigravity topic`)
    return current
  }
}
