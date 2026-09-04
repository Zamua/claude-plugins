import {
  applyOpencodePending,
  opencodeSessionName,
  renderOpencodeKickoff,
  renderOpencodeTurn,
  requestOpencodeRestart,
  withOpencodeSession,
} from '../domain/opencode-topic'
import type {
  OpencodeTopic,
  OpencodeTopicRepository,
} from '../domain/opencode-topic'
import type { InboundMessage } from '../domain/inbound-delivery'
import type {
  OpencodeOutboundPort,
  OpencodeRuntimePort,
} from './opencode-ports'

const NOTICE_LIMIT = 3_500
const OUTPUT_CAP_NOTICE =
  'OpenCode hit its output limit before replying; try a smaller step or say continue.'
const NO_REPLY_NOTICE = 'OpenCode finished this turn without sending a reply.'
const SETTLE_TIMEOUT_MS = 31 * 60_000
const TYPING_INTERVAL_MS = 4_000

// One outstanding settle watcher per topic. Every injection while it waits
// bumps `version` and moves `injectedAt` forward, so the watcher only acts on
// the newest turn.
type SettleWatch = {
  sessionName: string
  opencodeSessionId?: string
  injectedAt: number
  version: number
  // False once the settle wait has ended; a later injection needs a new watch.
  waiting: boolean
  done: Promise<void>
}

export type OpencodeChangeResult = {
  topic: OpencodeTopic
  pending: boolean
}

export class OpencodeTopicService {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly watchers = new Map<string, SettleWatch>()

  constructor(
    private readonly repository: OpencodeTopicRepository,
    private readonly runtime: OpencodeRuntimePort,
    private readonly outbound: OpencodeOutboundPort,
    private readonly now: () => number = Date.now,
  ) {}

  list(): OpencodeTopic[] {
    return this.repository.list()
  }

  get(topic: string): OpencodeTopic | undefined {
    return this.repository.get(topic)
  }

  isLocked(topic: string): boolean {
    return this.repository.get(topic)?.harness === 'opencode'
  }

  activate(topic: OpencodeTopic): OpencodeTopic {
    const existing = this.repository.get(topic.topic)
    if (existing) throw new Error(`topic ${topic.topic} is already OpenCode-managed`)
    this.repository.save(topic)
    return topic
  }

  rename(topicId: string, name: string): OpencodeTopic {
    const current = this.required(topicId)
    const changed = { ...current, name: name.trim() || current.name, updatedAt: this.now() }
    this.repository.save(changed)
    return changed
  }

  async start(topicId: string): Promise<OpencodeTopic> {
    return this.serialize(topicId, () => this.ensureReady(topicId))
  }

  async requestRelaunch(topicId: string): Promise<OpencodeChangeResult> {
    const requested = requestOpencodeRestart(this.required(topicId), this.now())
    this.repository.save(requested)
    return this.applyPendingIfIdle(topicId)
  }

  async reconcilePending(): Promise<void> {
    for (const topic of this.repository.list()) {
      if (!topic.restartPending) continue
      try {
        await this.applyPendingIfIdle(topic.topic)
      } catch (error) {
        await this.reportError(topic.topic, error)
      }
    }
  }

  submitTurn(topicId: string, message: InboundMessage): Promise<void> {
    return this.serialize(topicId, () => this.executeTurn(topicId, message))
  }

  // One per-topic queue for turns, starts, and pending-restart application, so
  // a relaunch can never race a turn's ensureReady or another relaunch.
  private serialize<T>(topicId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(topicId) ?? Promise.resolve()
    const queued = prior.catch(() => {}).then(task)
    const tracked = queued.then(() => {}, () => {})
    this.queues.set(topicId, tracked)
    void tracked.then(() => {
      if (this.queues.get(topicId) === tracked) this.queues.delete(topicId)
    })
    return queued
  }

  // True while a turn is queued, being injected, or not yet settled, so a
  // relaunch keeps deferring until the pane is between turns.
  busy(topicId: string): boolean {
    return this.queues.has(topicId) || this.watchers.has(topicId)
  }

  // Resolves once no settle watcher is outstanding for the topic.
  async drained(topicId: string): Promise<void> {
    for (;;) {
      const watch = this.watchers.get(topicId)
      if (!watch) return
      await watch.done
    }
  }

  async status(topicId: string) {
    const topic = this.required(topicId)
    return topic.sessionName ? this.runtime.status(topic.sessionName) : 'missing'
  }

  // Injection is immediate: OpenCode queues text typed during a running turn,
  // so a turn never waits for the previous one to settle.
  private async executeTurn(topicId: string, message: InboundMessage): Promise<void> {
    try {
      const ready = await this.ensureReady(topicId)
      await this.runtime.inject(ready.sessionName!, renderOpencodeTurn(message))
      this.watchSettle(topicId, ready.sessionName!, ready.opencodeSessionId, this.now())
    } catch (error) {
      await this.reportError(topicId, error)
    }
  }

  private watchSettle(
    topicId: string,
    sessionName: string,
    opencodeSessionId: string | undefined,
    injectedAt: number,
  ): void {
    const existing = this.watchers.get(topicId)
    if (existing?.waiting) {
      existing.injectedAt = injectedAt
      existing.version++
      existing.opencodeSessionId = opencodeSessionId
      return
    }
    const watch: SettleWatch = {
      sessionName, opencodeSessionId, injectedAt, version: 0, waiting: true, done: Promise.resolve(),
    }
    watch.done = this.runWatch(topicId, watch)
    this.watchers.set(topicId, watch)
  }

  private async runWatch(topicId: string, watch: SettleWatch): Promise<void> {
    this.outbound.typing(topicId)
    const typing = setInterval(() => this.outbound.typing(topicId), TYPING_INTERVAL_MS)
    try {
      let version: number
      do {
        version = watch.version
        await this.runtime.awaitSettled(watch.sessionName, SETTLE_TIMEOUT_MS)
      } while (version !== watch.version)
      watch.waiting = false
      clearInterval(typing)
      await this.backstopReply(topicId, watch.opencodeSessionId, watch.injectedAt)
      // A turn injected after settle has its own watcher, which applies the
      // restart at its settle instead of mid-turn here.
      await this.serialize(topicId, async () => {
        if (this.watchers.get(topicId) !== watch) return
        await this.applyPendingAfterOwnedTurn(topicId)
      })
    } catch (error) {
      await this.reportError(topicId, error)
    } finally {
      watch.waiting = false
      clearInterval(typing)
      if (this.watchers.get(topicId) === watch) this.watchers.delete(topicId)
    }
  }

  // OpenCode has no Stop hook: a turn can end in the terminal or at the output
  // cap with nothing sent. The proxy relays what the model produced instead.
  private async backstopReply(
    topicId: string,
    opencodeSessionId: string | undefined,
    startedAt: number,
  ): Promise<void> {
    if (this.outbound.repliedSince(topicId, startedAt)) return
    try {
      const last = opencodeSessionId
        ? await this.runtime.lastAssistantText(opencodeSessionId).catch(() => undefined)
        : undefined
      const text = last?.text ?? ''
      const notice = text
        ? (text.length > NOTICE_LIMIT ? `${text.slice(0, NOTICE_LIMIT)}…` : text)
        : last?.finish === 'length' ? OUTPUT_CAP_NOTICE : NO_REPLY_NOTICE
      await this.outbound.notice(topicId, notice)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await this.outbound.error(topicId, `OpenCode reply backstop failed: ${detail}`)
      } catch {}
    }
  }

  private async ensureReady(topicId: string): Promise<OpencodeTopic> {
    const current = this.required(topicId)
    const sessionName = current.sessionName ?? opencodeSessionName(current.topic, current.name)
    const identity = await this.runtime.ensureSession({
      topic: current.topic,
      name: current.name,
      sessionName,
      opencodeSessionId: current.opencodeSessionId,
      kickoff: renderOpencodeKickoff(),
    })
    if (current.opencodeSessionId && identity.opencodeSessionId !== current.opencodeSessionId) {
      await this.runtime.stop(identity.sessionName).catch(() => false)
      throw new Error(
        `OpenCode changed session identity from ${current.opencodeSessionId} ` +
        `to ${identity.opencodeSessionId}; refusing to fork this topic`,
      )
    }
    // A restart request may land while the pane is starting. Re-read so saving
    // runtime identity cannot roll pending state back.
    const latest = this.required(topicId)
    const running = withOpencodeSession(
      latest,
      identity.sessionName,
      identity.opencodeSessionId,
      this.now(),
    )
    this.repository.save(running)
    return running
  }

  private async applyPendingIfIdle(topicId: string): Promise<OpencodeChangeResult> {
    const current = this.required(topicId)
    if (!current.restartPending) return { topic: current, pending: false }
    if (this.busy(topicId)) return { topic: current, pending: true }
    const state = current.sessionName ? await this.runtime.status(current.sessionName) : 'missing'
    if (state === 'busy' || state === 'starting' || state === 'blocked') {
      return { topic: current, pending: true }
    }
    const applied = await this.serialize(topicId, () => this.applyPendingNow(topicId))
    return { topic: applied, pending: false }
  }

  private async applyPendingAfterOwnedTurn(topicId: string): Promise<void> {
    const current = this.required(topicId)
    if (!current.restartPending) return
    await this.applyPendingNow(topicId)
  }

  // Runs inside the per-topic queue. Clearing the pending flag before the stop
  // makes a second queued application a no-op instead of a second relaunch.
  private async applyPendingNow(topicId: string): Promise<OpencodeTopic> {
    const current = this.required(topicId)
    if (!current.restartPending) return current
    const applied = applyOpencodePending(current, this.now())
    this.repository.save(applied)
    if (current.sessionName) await this.runtime.stop(current.sessionName)
    return this.ensureReady(topicId)
  }

  private async reportError(topicId: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      await this.outbound.error(topicId, `OpenCode could not complete this turn: ${detail}`)
    } catch {}
  }

  private required(topic: string): OpencodeTopic {
    const current = this.repository.get(topic)
    if (!current) throw new Error(`topic ${topic} is not an OpenCode topic`)
    return current
  }
}
