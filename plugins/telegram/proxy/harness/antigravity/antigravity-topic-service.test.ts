import { describe, expect, test } from 'bun:test'
import { AntigravityTopicService } from './antigravity-topic-service'
import { antigravityRoute, antigravityTopic } from './domain/antigravity-topic'
import type {
  AntigravityTopic,
  AntigravityTopicRepository,
} from './domain/antigravity-topic'
import type {
  AntigravityRuntimePort,
  AntigravitySessionSpec,
  AntigravitySessionStatus,
} from './antigravity-ports'

const model = {
  id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash',
  variants: { medium: 'gemini-3.8-flash-medium' },
  efforts: ['medium'] as const, defaultEffort: 'medium' as const,
}

class MemoryRepository implements AntigravityTopicRepository {
  topics = new Map<string, AntigravityTopic>()
  list() { return [...this.topics.values()].map(value => structuredClone(value)) }
  get(topic: string) {
    const value = this.topics.get(topic)
    return value ? structuredClone(value) : undefined
  }
  save(topic: AntigravityTopic) { this.topics.set(topic.topic, structuredClone(topic)) }
}

class MemoryRuntime implements AntigravityRuntimePort {
  launches: AntigravitySessionSpec[] = []
  prompts: Array<{ sessionName: string; prompt: string }> = []
  stops: string[] = []
  currentStatus: AntigravitySessionStatus = 'missing'
  returnedConversationId = 'conv-1'

  async models() { return [model] }
  async usage() { return [] }
  async status() { return this.currentStatus }
  async ensureSession(input: AntigravitySessionSpec) {
    this.launches.push(structuredClone(input))
    this.currentStatus = 'idle'
    return { sessionName: input.sessionName, conversationId: this.returnedConversationId }
  }
  async prompt(sessionName: string, prompt: string) {
    this.prompts.push({ sessionName, prompt })
  }
  async stop(sessionName: string) {
    this.stops.push(sessionName)
    this.currentStatus = 'missing'
    return true
  }
}

// A runtime whose stop waits for `release`, counting how many stops and launches overlap.
class GatedRuntime extends MemoryRuntime {
  private open: Array<() => void> = []
  active = 0
  mostAtOnce = 0
  release() {
    for (const go of this.open.splice(0)) go()
  }
  private async span<T>(run: () => Promise<T>): Promise<T> {
    this.active++
    this.mostAtOnce = Math.max(this.mostAtOnce, this.active)
    try {
      return await run()
    } finally {
      this.active--
    }
  }
  override async stop(sessionName: string) {
    return this.span(async () => {
      await new Promise<void>(go => this.open.push(go))
      return super.stop(sessionName)
    })
  }
  override async ensureSession(input: AntigravitySessionSpec) {
    return this.span(() => super.ensureSession(input))
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('AntigravityTopicService', () => {
  test('launches one persistent Herdr session and injects later Telegram turns into it', async () => {
    const repository = new MemoryRepository()
    repository.save(antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10))
    const runtime = new MemoryRuntime()
    const service = new AntigravityTopicService(repository, runtime, {
      typing() {},
      async error(_topic, text) { throw new Error(text) },
    }, () => 20)

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    await service.submitTurn('42', { content: 'two', meta: { chat_id: '-1', user: 'u' } })

    expect(runtime.launches).toHaveLength(2)
    expect(runtime.launches[0].kickoff).toContain('persistent Herdr workspace')
    expect(runtime.launches[1].conversationId).toBe('conv-1')
    expect(runtime.prompts).toHaveLength(2)
    expect(runtime.prompts[0].sessionName).toBe('agy-pilot-42')
    expect(runtime.prompts[0].prompt).toContain('<channel source="telegram"')
    expect(repository.get('42')?.conversationId).toBe('conv-1')
    expect(repository.get('42')?.sessionName).toBe('agy-pilot-42')
  })

  test('refuses a runtime that silently forks the conversation', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10),
      conversationId: 'conv-1',
    })
    const errors: string[] = []
    const runtime = new MemoryRuntime()
    runtime.returnedConversationId = 'conv-2'
    const service = new AntigravityTopicService(repository, runtime, {
      typing() {}, async error(_topic, text) { errors.push(text) },
    })

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    expect(repository.get('42')?.conversationId).toBe('conv-1')
    expect(errors[0]).toContain('changed conversation identity')
    expect(runtime.prompts).toHaveLength(0)
  })

  test('relaunches an idle pane onto a new route with the same conversation id', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10),
      conversationId: 'conv-1',
      sessionName: 'agy-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.currentStatus = 'idle'
    const service = new AntigravityTopicService(repository, runtime, { typing() {}, async error() {} }, () => 30)
    const result = await service.requestRoute('42', antigravityRoute({
      ...model,
      id: 'claude-opus-4-6-thinking',
      label: 'Claude Opus 4.6 (Thinking)',
      variants: {},
      efforts: ['high'],
      defaultEffort: 'high',
    }, 'high'))
    expect(result.pending).toBeFalse()
    expect(runtime.stops).toEqual(['agy-pilot-42'])
    expect(runtime.launches.at(-1)?.conversationId).toBe('conv-1')
    expect(runtime.launches.at(-1)?.route.modelVariant).toBe('claude-opus-4-6-thinking')
    expect(repository.get('42')?.conversationId).toBe('conv-1')
    expect(repository.get('42')?.route.model).toBe('claude-opus-4-6-thinking')
  })

  test('queues a route change while Herdr is busy and applies it after the turn', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10),
      conversationId: 'conv-1', sessionName: 'agy-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.currentStatus = 'busy'
    const service = new AntigravityTopicService(repository, runtime, { typing() {}, async error() {} })
    const next = antigravityRoute({ ...model, id: 'next', label: 'Next' }, 'medium')

    const result = await service.requestRoute('42', next)
    expect(result.pending).toBeTrue()
    expect(repository.get('42')?.pendingRoute?.model).toBe('next')
    expect(runtime.stops).toHaveLength(0)

    runtime.currentStatus = 'idle'
    await service.reconcilePending()
    expect(runtime.stops).toEqual(['agy-pilot-42'])
    expect(repository.get('42')?.pendingRoute).toBeUndefined()
    expect(repository.get('42')?.route.model).toBe('next')
  })

  test('queues a relaunch while busy and resumes the same conversation when idle', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10),
      conversationId: 'conv-1', sessionName: 'agy-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.currentStatus = 'busy'
    const service = new AntigravityTopicService(repository, runtime, { typing() {}, async error() {} })

    expect((await service.requestRelaunch('42')).pending).toBeTrue()
    runtime.currentStatus = 'idle'
    await service.reconcilePending()

    expect(runtime.stops).toEqual(['agy-pilot-42'])
    expect(runtime.launches.at(-1)?.conversationId).toBe('conv-1')
    expect(repository.get('42')?.restartPending).toBeUndefined()
  })

  test('a route requested while a relaunch is stopping the pane applies after it, one change at a time', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10),
      conversationId: 'conv-1', sessionName: 'agy-pilot-42',
    })
    const runtime = new GatedRuntime()
    runtime.currentStatus = 'idle'
    const service = new AntigravityTopicService(repository, runtime, { typing() {}, async error() {} })
    const first = service.requestRoute('42', antigravityRoute({ ...model, id: 'first', label: 'First' }, 'medium'))
    await settle()
    // The operator picks again, and the reconcile tick runs, while the first change is still stopping the pane
    const second = service.requestRoute('42', antigravityRoute({ ...model, id: 'second', label: 'Second' }, 'medium'))
    const tick = service.reconcilePending()
    const drain = async (work: Promise<unknown>) => {
      for (let i = 0; i < 10; i++) {
        runtime.release()
        await settle()
      }
      await work
    }
    await drain(Promise.all([first, second, tick]))
    expect(repository.get('42')?.pendingRoute?.model).toBe('second')
    // The next tick finds the pane idle and applies the second change
    await drain(service.reconcilePending())

    expect(runtime.mostAtOnce).toBe(1)
    expect(runtime.stops).toHaveLength(2)
    expect(repository.get('42')?.route.model).toBe('second')
    expect(repository.get('42')?.pendingRoute).toBeUndefined()
  })
})
