import { describe, expect, test } from 'bun:test'
import { AntigravityTopicService } from './antigravity-topic-service'
import { antigravityRoute, antigravityTopic } from '../domain/antigravity-topic'
import type {
  AntigravityTopic,
  AntigravityTopicRepository,
} from '../domain/antigravity-topic'
import type { AntigravityRuntimePort, AntigravityTurn } from './antigravity-ports'

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

describe('AntigravityTopicService', () => {
  test('persists and reuses one exact Antigravity conversation across turns', async () => {
    const repository = new MemoryRepository()
    repository.save(antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10))
    const calls: AntigravityTurn[] = []
    const runtime: AntigravityRuntimePort = {
      async models() { return [model] },
      async usage() { return [] },
      async turn(input) {
        calls.push(input)
        return { conversationId: 'conv-1', response: calls.length === 1 ? 'first' : 'second', status: 'SUCCESS' }
      },
    }
    const replies: string[] = []
    const service = new AntigravityTopicService(repository, runtime, {
      typing() {},
      async reply(_topic, text) { replies.push(text) },
      async error(_topic, text) { throw new Error(text) },
    }, () => 20)

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    await service.submitTurn('42', { content: 'two', meta: { chat_id: '-1', user: 'u' } })

    expect(calls[0].conversationId).toBeUndefined()
    expect(calls[0].prompt).toContain('Configuration interoperability')
    expect(calls[1].conversationId).toBe('conv-1')
    expect(calls[1].prompt).not.toContain('Configuration interoperability')
    expect(repository.get('42')?.conversationId).toBe('conv-1')
    expect(replies).toEqual(['first', 'second'])
  })

  test('refuses a runtime that silently forks the conversation', async () => {
    const repository = new MemoryRepository()
    repository.save({
      ...antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10),
      conversationId: 'conv-1',
    })
    const errors: string[] = []
    const service = new AntigravityTopicService(repository, {
      async models() { return [model] },
      async usage() { return [] },
      async turn() { return { conversationId: 'conv-2', response: 'wrong', status: 'SUCCESS' } },
    }, {
      typing() {}, async reply() {}, async error(_topic, text) { errors.push(text) },
    })

    await service.submitTurn('42', { content: 'one', meta: { chat_id: '-1', user: 'u' } })
    expect(repository.get('42')?.conversationId).toBe('conv-1')
    expect(errors[0]).toContain('changed conversation identity')
  })

  test('changes only model and effort while retaining the conversation id', () => {
    const repository = new MemoryRepository()
    repository.save({
      ...antigravityTopic('42', 'pilot', antigravityRoute(model, 'medium'), 10),
      conversationId: 'conv-1',
    })
    const service = new AntigravityTopicService(repository, {} as any, {} as any, () => 30)
    const changed = service.changeRoute('42', antigravityRoute({
      ...model,
      id: 'claude-opus-4-6-thinking',
      label: 'Claude Opus 4.6 (Thinking)',
      variants: {},
      efforts: ['high'],
      defaultEffort: 'high',
    }, 'high'))
    expect(changed.conversationId).toBe('conv-1')
    expect(changed.route.model).toBe('claude-opus-4-6-thinking')
  })
})
