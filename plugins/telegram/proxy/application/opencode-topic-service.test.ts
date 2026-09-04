import { describe, expect, test } from 'bun:test'
import { OpencodeTopicService } from './opencode-topic-service'
import { opencodeTopic } from '../domain/opencode-topic'
import type {
  OpencodeTopic,
  OpencodeTopicRepository,
} from '../domain/opencode-topic'
import type {
  OpencodeAssistantText,
  OpencodeOutboundPort,
  OpencodeRuntimePort,
  OpencodeSessionSpec,
  OpencodeSessionStatus,
} from './opencode-ports'

class MemoryRepository implements OpencodeTopicRepository {
  topics = new Map<string, OpencodeTopic>()
  list() { return [...this.topics.values()].map(value => structuredClone(value)) }
  get(topic: string) {
    const value = this.topics.get(topic)
    return value ? structuredClone(value) : undefined
  }
  save(topic: OpencodeTopic) { this.topics.set(topic.topic, structuredClone(topic)) }
}

class MemoryRuntime implements OpencodeRuntimePort {
  launches: OpencodeSessionSpec[] = []
  prompts: Array<{ sessionName: string; prompt: string }> = []
  stops: string[] = []
  currentStatus: OpencodeSessionStatus = 'missing'
  returnedSessionId = 'ses_1'
  promptError: Error | undefined
  exported: OpencodeAssistantText | undefined
  exportedFor: string[] = []
  settleCalls = 0
  // When set, awaitSettled blocks until the test releases it.
  settleGate: (() => void)[] | undefined

  async status() { return this.currentStatus }
  async lastAssistantText(opencodeSessionId: string) {
    this.exportedFor.push(opencodeSessionId)
    return this.exported
  }
  async ensureSession(input: OpencodeSessionSpec) {
    this.launches.push(structuredClone(input))
    this.currentStatus = 'idle'
    return { sessionName: input.sessionName, opencodeSessionId: this.returnedSessionId }
  }
  async inject(sessionName: string, prompt: string) {
    if (this.promptError) throw this.promptError
    this.prompts.push({ sessionName, prompt })
  }
  async awaitSettled() {
    this.settleCalls++
    if (this.settleGate) await new Promise<void>(resolve => this.settleGate!.push(resolve))
  }
  releaseSettle() {
    const waiting = this.settleGate ?? []
    this.settleGate = []
    for (const resolve of waiting) resolve()
  }
  async stop(sessionName: string) {
    this.stops.push(sessionName)
    this.currentStatus = 'missing'
    return true
  }
}

// Every turn counts as replied unless a test says otherwise.
const outbound = (overrides: Partial<OpencodeOutboundPort> = {}): OpencodeOutboundPort => ({
  typing() {},
  async error() {},
  repliedSince() { return true },
  async notice() {},
  ...overrides,
})
const silent = outbound()

const unreplied = () => {
  const notices: string[] = []
  const port = outbound({
    repliedSince() { return false },
    async notice(_topic, text) { notices.push(text) },
  })
  return { port, notices }
}

describe('OpencodeTopicService', () => {
  test('launches one persistent Herdr session and injects later Telegram turns into it', async () => {
    const repository = new MemoryRepository()
    repository.save(opencodeTopic('42', 'pilot', 10))
    const runtime = new MemoryRuntime()
    const service = new OpencodeTopicService(repository, runtime, outbound({
      async error(_topic, text) { throw new Error(text) },
    }), () => 20)

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    await service.drained('42')
    await service.submitTurn('42', { content: 'two', meta: { chat_id: '-1', user: 'u' } })
    await service.drained('42')

    expect(runtime.launches).toHaveLength(2)
    expect(runtime.launches[0].opencodeSessionId).toBeUndefined()
    expect(runtime.launches[0].kickoff).toContain('persistent Herdr workspace')
    expect(runtime.launches[1].opencodeSessionId).toBe('ses_1')
    expect(runtime.prompts).toHaveLength(2)
    expect(runtime.prompts[0].sessionName).toBe('oc-pilot-42')
    expect(runtime.prompts[0].prompt).toContain('<channel source="telegram"')
    expect(runtime.prompts[0].prompt).toContain('telegram-topics_reply')
    expect(repository.get('42')?.opencodeSessionId).toBe('ses_1')
    expect(repository.get('42')?.sessionName).toBe('oc-pilot-42')
  })

  test('refuses a runtime that silently forks the session and stops the pane', async () => {
    const repository = new MemoryRepository()
    repository.save({ ...opencodeTopic('42', 'pilot', 10), opencodeSessionId: 'ses_1' })
    const errors: string[] = []
    const runtime = new MemoryRuntime()
    runtime.returnedSessionId = 'ses_2'
    const service = new OpencodeTopicService(repository, runtime, outbound({
      async error(_topic, text) { errors.push(text) },
    }))

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    expect(repository.get('42')?.opencodeSessionId).toBe('ses_1')
    expect(errors[0]).toStartWith('OpenCode could not complete this turn: ')
    expect(errors[0]).toContain('changed session identity')
    expect(runtime.stops).toEqual(['oc-pilot-42'])
    expect(runtime.prompts).toHaveLength(0)
  })

  test('reports a prompt failure through the outbound error port', async () => {
    const repository = new MemoryRepository()
    repository.save(opencodeTopic('42', 'pilot', 10))
    const errors: string[] = []
    const runtime = new MemoryRuntime()
    runtime.promptError = new Error('agent_prompt_stalled')
    const service = new OpencodeTopicService(repository, runtime, outbound({
      async error(_topic, text) { errors.push(text) },
    }))

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    expect(errors).toEqual(['OpenCode could not complete this turn: agent_prompt_stalled'])
  })

  test('serializes turns per topic and clears the queue afterwards', async () => {
    const repository = new MemoryRepository()
    repository.save(opencodeTopic('42', 'pilot', 10))
    const runtime = new MemoryRuntime()
    const service = new OpencodeTopicService(repository, runtime, silent)

    const first = service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    const second = service.submitTurn('42', { content: 'two', meta: { chat_id: '-1', user: 'u' } })
    expect(service.busy('42')).toBeTrue()
    await Promise.all([first, second])
    await service.drained('42')
    expect(service.busy('42')).toBeFalse()
    expect(runtime.prompts.map(p => p.prompt.includes('\none\n'))).toEqual([true, false])
  })

  test('a second turn is injected immediately while the first has not settled', async () => {
    const repository = new MemoryRepository()
    repository.save(opencodeTopic('42', 'pilot', 10))
    const runtime = new MemoryRuntime()
    runtime.settleGate = []
    const service = new OpencodeTopicService(repository, runtime, silent)

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    await service.submitTurn('42', { content: 'two', meta: { chat_id: '-1', user: 'u' } })
    expect(runtime.prompts).toHaveLength(2)
    expect(runtime.settleCalls).toBe(1)
    expect(service.busy('42')).toBeTrue()

    // One wait per injection: the second injection restarts the watcher's wait.
    runtime.releaseSettle()
    runtime.settleGate = undefined
    await service.drained('42')
    expect(runtime.settleCalls).toBe(2)
    expect(service.busy('42')).toBeFalse()
  })

  test('the settle watcher debounces to the newest injection', async () => {
    const repository = new MemoryRepository()
    repository.save({ ...opencodeTopic('42', 'pilot', 10), opencodeSessionId: 'ses_1' })
    const runtime = new MemoryRuntime()
    runtime.settleGate = []
    runtime.exported = { text: 'terminal only' }
    const asked: number[] = []
    const notices: string[] = []
    let clock = 100
    const service = new OpencodeTopicService(repository, runtime, outbound({
      repliedSince(_topic, since) { asked.push(since); return since < 200 },
      async notice(_topic, text) { notices.push(text) },
    }), () => clock)

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    clock = 200
    await service.submitTurn('42', { content: 'two', meta: { chat_id: '-1', user: 'u' } })
    runtime.releaseSettle()
    await new Promise(resolve => setTimeout(resolve, 1))
    // The first wait ended after a newer injection, so the watcher waits again.
    expect(runtime.settleCalls).toBe(2)
    expect(asked).toEqual([])
    runtime.releaseSettle()
    await service.drained('42')
    expect(asked).toEqual([200])
    expect(notices).toEqual(['terminal only'])
  })

  test('a turn injected after settle gets its own watcher', async () => {
    const repository = new MemoryRepository()
    repository.save(opencodeTopic('42', 'pilot', 10))
    const runtime = new MemoryRuntime()
    const service = new OpencodeTopicService(repository, runtime, silent)

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    await service.drained('42')
    await service.submitTurn('42', { content: 'two', meta: { chat_id: '-1', user: 'u' } })
    await service.drained('42')
    expect(runtime.settleCalls).toBe(2)
  })

  test('a settle failure is reported through the outbound error port', async () => {
    const repository = new MemoryRepository()
    repository.save(opencodeTopic('42', 'pilot', 10))
    const errors: string[] = []
    const runtime = new MemoryRuntime()
    runtime.awaitSettled = async () => { throw new Error('pane is blocked') }
    const service = new OpencodeTopicService(repository, runtime, outbound({
      async error(_topic, text) { errors.push(text) },
    }))

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    await service.drained('42')
    expect(errors).toEqual(['OpenCode could not complete this turn: pane is blocked'])
  })

  test('keeps the typing indicator alive while a watcher is outstanding', async () => {
    const repository = new MemoryRepository()
    repository.save(opencodeTopic('42', 'pilot', 10))
    const runtime = new MemoryRuntime()
    runtime.settleGate = []
    let typed = 0
    const service = new OpencodeTopicService(repository, runtime, outbound({
      typing() { typed++ },
    }))

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    expect(typed).toBe(1)
    runtime.releaseSettle()
    await service.drained('42')
  })

  test('relaunches an idle pane onto the same OpenCode session id', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...opencodeTopic('42', 'pilot', 10),
      opencodeSessionId: 'ses_1',
      sessionName: 'oc-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.currentStatus = 'idle'
    const service = new OpencodeTopicService(repository, runtime, silent, () => 30)

    const result = await service.requestRelaunch('42')
    expect(result.pending).toBeFalse()
    expect(runtime.stops).toEqual(['oc-pilot-42'])
    expect(runtime.launches.at(-1)?.opencodeSessionId).toBe('ses_1')
    expect(repository.get('42')?.opencodeSessionId).toBe('ses_1')
    expect(repository.get('42')?.restartPending).toBeUndefined()
  })

  test('queues a relaunch while busy and resumes the same session when idle', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...opencodeTopic('42', 'pilot', 10),
      opencodeSessionId: 'ses_1', sessionName: 'oc-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.currentStatus = 'busy'
    const service = new OpencodeTopicService(repository, runtime, silent)

    expect((await service.requestRelaunch('42')).pending).toBeTrue()
    expect(repository.get('42')?.restartPending).toBeTrue()
    expect(runtime.stops).toHaveLength(0)

    runtime.currentStatus = 'idle'
    await service.reconcilePending()

    expect(runtime.stops).toEqual(['oc-pilot-42'])
    expect(runtime.launches.at(-1)?.opencodeSessionId).toBe('ses_1')
    expect(repository.get('42')?.restartPending).toBeUndefined()
  })

  test('applies a restart requested during an owned turn once that turn ends', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...opencodeTopic('42', 'pilot', 10),
      opencodeSessionId: 'ses_1', sessionName: 'oc-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.settleGate = []
    const service = new OpencodeTopicService(repository, runtime, silent)

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    expect(runtime.prompts).toHaveLength(1)
    expect((await service.requestRelaunch('42')).pending).toBeTrue()
    expect(runtime.stops).toHaveLength(0)

    runtime.releaseSettle()
    await service.drained('42')
    expect(runtime.stops).toEqual(['oc-pilot-42'])
    expect(runtime.launches).toHaveLength(2)
    expect(repository.get('42')?.restartPending).toBeUndefined()
  })

  test('two concurrent relaunch triggers stop and relaunch exactly once', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...opencodeTopic('42', 'pilot', 10),
      opencodeSessionId: 'ses_1', sessionName: 'oc-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.currentStatus = 'idle'
    const service = new OpencodeTopicService(repository, runtime, silent)

    const results = await Promise.all([
      service.requestRelaunch('42'),
      service.reconcilePending(),
      service.requestRelaunch('42'),
    ])
    expect(runtime.stops).toEqual(['oc-pilot-42'])
    expect(runtime.launches).toHaveLength(1)
    expect(results[0].pending).toBeFalse()
    expect(repository.get('42')?.restartPending).toBeUndefined()
  })

  test('a turn submitted during a relaunch runs only after it', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...opencodeTopic('42', 'pilot', 10),
      opencodeSessionId: 'ses_1', sessionName: 'oc-pilot-42',
    })
    const runtime = new MemoryRuntime()
    runtime.currentStatus = 'idle'
    const order: string[] = []
    let release!: () => void
    const baseEnsure = runtime.ensureSession.bind(runtime)
    runtime.ensureSession = async input => {
      order.push('launch')
      if (!release) await new Promise<void>(resolve => { release = resolve })
      return baseEnsure(input)
    }
    runtime.inject = async (sessionName, prompt) => {
      order.push('prompt')
      runtime.prompts.push({ sessionName, prompt })
    }
    const service = new OpencodeTopicService(repository, runtime, silent)

    const relaunch = service.requestRelaunch('42')
    while (!release) await new Promise(resolve => setTimeout(resolve, 1))
    expect(repository.get('42')?.restartPending).toBeUndefined()
    const turn = service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(runtime.prompts).toHaveLength(0)

    release()
    await Promise.all([relaunch, turn])
    await service.drained('42')
    expect(order).toEqual(['launch', 'launch', 'prompt'])
    expect(runtime.stops).toEqual(['oc-pilot-42'])
    expect(runtime.launches).toHaveLength(2)
  })

  test('activate, rename, isLocked, and status follow repository state', async () => {
    const repository = new MemoryRepository()
    const runtime = new MemoryRuntime()
    const service = new OpencodeTopicService(repository, runtime, silent, () => 50)

    expect(service.isLocked('42')).toBeFalse()
    service.activate(opencodeTopic('42', 'pilot', 10))
    expect(service.isLocked('42')).toBeTrue()
    expect(() => service.activate(opencodeTopic('42', 'pilot', 10))).toThrow('already OpenCode-managed')
    expect(service.rename('42', 'renamed').name).toBe('renamed')
    expect(service.rename('42', '  ').name).toBe('renamed')
    expect(repository.get('42')?.updatedAt).toBe(50)
    expect(service.list()).toHaveLength(1)
    expect(await service.status('42')).toBe('missing')
    await service.start('42')
    expect(await service.status('42')).toBe('idle')
    expect(() => service.rename('7', 'x')).toThrow('not an OpenCode topic')
  })

  describe('reply backstop', () => {
    const turn = { content: 'one', meta: { chat_id: '-1', user: 'u' } }
    const setup = () => {
      const repository = new MemoryRepository()
      repository.save({ ...opencodeTopic('42', 'pilot', 10), opencodeSessionId: 'ses_1' })
      return { repository, runtime: new MemoryRuntime() }
    }

    test('a turn that replied through the MCP gets no notice', async () => {
      const { repository, runtime } = setup()
      runtime.exported = { text: 'terminal only', finish: 'stop' }
      const notices: string[] = []
      const service = new OpencodeTopicService(repository, runtime, outbound({
        repliedSince(_topic, since) { return since >= 0 },
        async notice(_topic, text) { notices.push(text) },
      }))
      await service.submitTurn('42', turn)
      await service.drained('42')
      expect(notices).toEqual([])
      expect(runtime.exportedFor).toEqual([])
    })

    test('relays the last assistant text when the turn never replied', async () => {
      const { repository, runtime } = setup()
      runtime.exported = { text: 'answered in the terminal', finish: 'stop' }
      const { port, notices } = unreplied()
      const service = new OpencodeTopicService(repository, runtime, port)
      await service.submitTurn('42', turn)
      await service.drained('42')
      expect(runtime.exportedFor).toEqual(['ses_1'])
      expect(notices).toEqual(['answered in the terminal'])
    })

    test('caps a long relayed text', async () => {
      const { repository, runtime } = setup()
      runtime.exported = { text: 'x'.repeat(5000) }
      const { port, notices } = unreplied()
      const service = new OpencodeTopicService(repository, runtime, port)
      await service.submitTurn('42', turn)
      await service.drained('42')
      expect(notices[0]).toHaveLength(3501)
      expect(notices[0]).toEndWith('…')
    })

    test('names the output cap when the model stopped at finish length', async () => {
      const { repository, runtime } = setup()
      runtime.exported = { text: '', finish: 'length' }
      const { port, notices } = unreplied()
      const service = new OpencodeTopicService(repository, runtime, port)
      await service.submitTurn('42', turn)
      await service.drained('42')
      expect(notices).toEqual([
        'OpenCode hit its output limit before replying; try a smaller step or say continue.',
      ])
    })

    test('falls back to a generic notice when the export is unavailable', async () => {
      const { repository, runtime } = setup()
      runtime.exported = undefined
      const { port, notices } = unreplied()
      const service = new OpencodeTopicService(repository, runtime, port)
      await service.submitTurn('42', turn)
      await service.drained('42')
      expect(notices).toEqual(['OpenCode finished this turn without sending a reply.'])
    })

    test('a failing notice is reported, never thrown', async () => {
      const { repository, runtime } = setup()
      const errors: string[] = []
      const service = new OpencodeTopicService(repository, runtime, outbound({
        repliedSince() { return false },
        async notice() { throw new Error('telegram down') },
        async error(_topic, text) { errors.push(text) },
      }))
      await service.submitTurn('42', turn)
      await service.drained('42')
      expect(errors).toEqual(['OpenCode reply backstop failed: telegram down'])
    })
  })
})
