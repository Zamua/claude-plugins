import {
  localgenCaption,
  localgenFailureText,
  localgenRequestBody,
  parseLocalgenPrompt,
  randomLocalgenSeed,
} from '../domain/localgen-topic'
import type {
  LocalgenFailure,
  LocalgenOptions,
  LocalgenTopic,
  LocalgenTopicRepository,
} from '../domain/localgen-topic'
import type { LocalgenGeneratorPort, LocalgenOutboundPort } from './localgen-ports'

// Telegram expires a chat action after about 5 s.
const UPLOAD_ACTION_INTERVAL_MS = 5_000

export class LocalgenError extends Error {
  constructor(readonly failure: LocalgenFailure) {
    super(failure.kind)
  }
}

export class LocalgenTopicService {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly waiting = new Map<string, number>()

  constructor(
    private readonly repository: LocalgenTopicRepository,
    private readonly generator: LocalgenGeneratorPort,
    private readonly outbound: LocalgenOutboundPort,
    private readonly startCommand: string,
    private readonly now: () => number = Date.now,
    private readonly seed: () => number = randomLocalgenSeed,
  ) {}

  list(): LocalgenTopic[] {
    return this.repository.list()
  }

  get(topic: string): LocalgenTopic | undefined {
    return this.repository.get(topic)
  }

  isLocked(topic: string): boolean {
    return this.repository.get(topic)?.harness === 'localgen'
  }

  activate(topic: LocalgenTopic): LocalgenTopic {
    if (this.repository.get(topic.topic)) throw new Error(`topic ${topic.topic} is already localgen-managed`)
    this.repository.save(topic)
    return topic
  }

  rename(topicId: string, name: string): LocalgenTopic {
    const current = this.repository.get(topicId)
    if (!current) throw new Error(`topic ${topicId} is not a localgen topic`)
    const changed = { ...current, name: name.trim() || current.name, updatedAt: this.now() }
    this.repository.save(changed)
    return changed
  }

  // Parses the message, then runs the request(s) behind everything already
  // queued for the topic. Resolves once the message's images are delivered.
  submit(topicId: string, text: string): Promise<void> {
    const parsed = parseLocalgenPrompt(text, this.seed)
    if ('error' in parsed) return this.outbound.error(topicId, parsed.error)
    const position = this.waiting.get(topicId) ?? 0
    this.waiting.set(topicId, position + 1)
    const prior = this.queues.get(topicId) ?? Promise.resolve()
    const queued = prior.then(() => this.generateAll(topicId, parsed)).finally(() => {
      this.waiting.set(topicId, (this.waiting.get(topicId) ?? 1) - 1)
      if (this.queues.get(topicId) === queued) this.queues.delete(topicId)
    })
    this.queues.set(topicId, queued)
    if (position > 0) void this.outbound.queued(topicId, position).catch(() => {})
    return queued
  }

  private async generateAll(topicId: string, options: LocalgenOptions): Promise<void> {
    for (let i = 0; i < options.n; i++) {
      const seed = options.seed + i
      this.outbound.uploading(topicId)
      const action = setInterval(() => this.outbound.uploading(topicId), UPLOAD_ACTION_INTERVAL_MS)
      const startedAt = this.now()
      try {
        const png = await this.generator.generate(localgenRequestBody(options, seed))
        clearInterval(action)
        await this.outbound.photo(
          topicId,
          png,
          `localgen-${seed}.png`,
          localgenCaption(seed, options.size, options.steps, this.now() - startedAt),
          options.raw,
        )
      } catch (error) {
        clearInterval(action)
        const text = error instanceof LocalgenError
          ? localgenFailureText(error.failure, this.startCommand)
          : `localgen failed: ${error instanceof Error ? error.message : String(error)}`
        await this.outbound.error(topicId, text).catch(() => {})
        return
      }
    }
  }
}
