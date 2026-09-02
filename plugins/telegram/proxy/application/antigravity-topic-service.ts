import {
  renderAntigravityTurn,
  withAntigravityConversation,
  withAntigravityRoute,
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

  changeRoute(topicId: string, route: AntigravityRoute): AntigravityTopic {
    const current = this.required(topicId)
    const changed = withAntigravityRoute(current, route, this.now())
    this.repository.save(changed)
    return changed
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

  private async executeTurn(topicId: string, message: InboundMessage): Promise<void> {
    try {
      const current = this.required(topicId)
      this.outbound.typing(topicId)
      const typing = setInterval(() => this.outbound.typing(topicId), 4_000)
      let result
      try {
        result = await this.runtime.turn({
          prompt: renderAntigravityTurn(message, !current.conversationId),
          modelVariant: current.route.modelVariant,
          effort: current.route.effort,
          conversationId: current.conversationId,
        })
      } finally {
        clearInterval(typing)
      }
      if (current.conversationId && result.conversationId !== current.conversationId) {
        throw new Error(
          `Antigravity changed conversation identity from ${current.conversationId} ` +
          `to ${result.conversationId}; refusing to fork this topic`,
        )
      }
      // A model switch may land while this turn is running. Re-read the
      // aggregate so recording the conversation id never rolls its new route
      // back to the route captured at turn start.
      const latest = this.required(topicId)
      this.repository.save(withAntigravityConversation(latest, result.conversationId, this.now()))
      await this.outbound.reply(topicId, result.response || '(Antigravity completed without a text response.)')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await this.outbound.error(topicId, `Antigravity could not complete this turn: ${detail}`)
      } catch {}
    }
  }

  private required(topic: string): AntigravityTopic {
    const current = this.repository.get(topic)
    if (!current) throw new Error(`topic ${topic} is not an Antigravity topic`)
    return current
  }
}
