import { describe, expect, test } from 'bun:test'
import { LocalgenError, LocalgenTopicService } from './localgen-topic-service'
import { localgenTopic } from '../domain/localgen-topic'
import type { LocalgenRequestBody, LocalgenTopic, LocalgenTopicRepository } from '../domain/localgen-topic'
import type { LocalgenGeneratorPort, LocalgenOutboundPort } from './localgen-ports'

class MemoryRepository implements LocalgenTopicRepository {
  topics = new Map<string, LocalgenTopic>()
  list() { return [...this.topics.values()].map(value => ({ ...value })) }
  get(topic: string) {
    const value = this.topics.get(topic)
    return value ? { ...value } : undefined
  }
  save(topic: LocalgenTopic) { this.topics.set(topic.topic, { ...topic }) }
}

class Generator implements LocalgenGeneratorPort {
  bodies: LocalgenRequestBody[] = []
  // When set, generate blocks until the test releases it.
  gate: (() => void)[] | undefined
  failWith: LocalgenError | undefined
  async generate(body: LocalgenRequestBody) {
    this.bodies.push(body)
    if (this.gate) await new Promise<void>(resolve => this.gate!.push(resolve))
    if (this.failWith) throw this.failWith
    return new Uint8Array([body.seed])
  }
  release() {
    const waiting = this.gate ?? []
    this.gate = []
    for (const resolve of waiting) resolve()
  }
}

class Outbound implements LocalgenOutboundPort {
  uploads = 0
  photos: Array<{ topic: string; seed: number; filename: string; caption: string; asDocument: boolean }> = []
  positions: number[] = []
  errors: string[] = []
  uploading() { this.uploads++ }
  async photo(topic: string, png: Uint8Array, filename: string, caption: string, asDocument: boolean) {
    this.photos.push({ topic, seed: png[0], filename, caption, asDocument })
  }
  async queued(_topic: string, position: number) { this.positions.push(position) }
  async error(_topic: string, text: string) { this.errors.push(text) }
}

function harness() {
  const repository = new MemoryRepository()
  const generator = new Generator()
  const outbound = new Outbound()
  let clock = 1_000
  const service = new LocalgenTopicService(
    repository, generator, outbound, 'pm2 start qwen-image', () => (clock += 30_000), () => 100,
  )
  service.activate(localgenTopic('9422', 'localgen', 1))
  return { repository, generator, outbound, service }
}

describe('localgen topic service', () => {
  test('locks, renames, and refuses a second activation', () => {
    const { service } = harness()
    expect(service.isLocked('9422')).toBeTrue()
    expect(service.isLocked('1')).toBeFalse()
    expect(service.rename('9422', 'art').name).toBe('art')
    expect(() => service.activate(localgenTopic('9422', 'x'))).toThrow('already localgen-managed')
    expect(() => service.rename('1', 'x')).toThrow('not a localgen topic')
  })

  test('one prompt is one request, one photo with the caption, and the upload action', async () => {
    const { generator, outbound, service } = harness()
    await service.submit('9422', 'a red fox steps:20')
    expect(generator.bodies).toEqual([
      { prompt: 'a red fox', size: '1024x1024', steps: 20, seed: 100, n: 1, response_format: 'b64_json' },
    ])
    expect(outbound.photos).toEqual([
      { topic: '9422', seed: 100, filename: 'localgen-100.png', caption: 'seed 100 · 1024x1024 · 20 steps · 0m30s', asDocument: false },
    ])
    expect(outbound.uploads).toBe(1)
    expect(outbound.positions).toEqual([])
  })

  test('n:K runs K sequential single-image requests with consecutive seeds; raw sends documents', async () => {
    const { generator, outbound, service } = harness()
    await service.submit('9422', 'fox n:3 seed:10 raw')
    expect(generator.bodies.map(body => body.seed)).toEqual([10, 11, 12])
    expect(outbound.photos.map(photo => photo.seed)).toEqual([10, 11, 12])
    expect(outbound.photos.every(photo => photo.asDocument)).toBeTrue()
  })

  test('prompts in one topic are serialized in order and later ones get a queue position', async () => {
    const { generator, outbound, service } = harness()
    generator.gate = []
    const first = service.submit('9422', 'one')
    const second = service.submit('9422', 'two')
    const third = service.submit('9422', 'three')
    await Promise.resolve()
    expect(generator.bodies.map(body => body.prompt)).toEqual(['one'])
    expect(outbound.positions).toEqual([1, 2])
    generator.release()
    await first
    await Promise.resolve()
    expect(generator.bodies.map(body => body.prompt)).toEqual(['one', 'two'])
    generator.release()
    await second
    await Promise.resolve()
    generator.release()
    await third
    expect(outbound.photos.map(photo => photo.topic)).toEqual(['9422', '9422', '9422'])
    expect(generator.bodies.map(body => body.prompt)).toEqual(['one', 'two', 'three'])
    // The queue drained: the next prompt runs immediately with no position.
    generator.gate = undefined
    await service.submit('9422', 'four')
    expect(outbound.positions).toEqual([1, 2])
  })

  test('an invalid option is answered without touching the generator', async () => {
    const { generator, outbound, service } = harness()
    await service.submit('9422', 'fox steps:500')
    expect(generator.bodies).toEqual([])
    expect(outbound.errors).toEqual(['steps must be in [1, 100]'])
  })

  test('a failed generation reports the mapped text, stops the batch, and never rejects', async () => {
    const { generator, outbound, service } = harness()
    generator.failWith = new LocalgenError({ kind: 'down', detail: 'ECONNREFUSED' })
    await service.submit('9422', 'fox n:2')
    expect(generator.bodies).toHaveLength(1)
    expect(outbound.photos).toEqual([])
    expect(outbound.errors).toEqual(['localgen server is down. Start it from the gpu topic:\npm2 start qwen-image'])
    generator.failWith = new LocalgenError({ kind: 'warming' })
    await service.submit('9422', 'fox')
    expect(outbound.errors.at(-1)).toBe('warming up, try again in a few minutes')
  })
})
