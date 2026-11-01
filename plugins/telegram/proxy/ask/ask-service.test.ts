import { describe, expect, test } from 'bun:test'
import type { TopicRoute } from '../routing/domain/model-routing'
import type { InboundMessage } from '../shared/domain/inbound-delivery'
import { createAsk } from './ask-service'
import type { AskPorts, AskSubmission } from './ask-service'
import { AskRefused } from './domain/ask'
import type { AskTarget } from './domain/ask'

type Sent = { method: string; chatId: string; other: Record<string, unknown> }

function harness(options: { target?: AskTarget | undefined; refuse?: string[]; transcript?: string | null; createFails?: number } = {}) {
  const sent: Sent[] = []
  const created: string[] = []
  const routed: Array<[string, TopicRoute]> = []
  const queued: Array<[string, InboundMessage]> = []
  let stored: string | undefined
  let nextId = 500
  let createFails = options.createFails ?? 0
  let onEnqueue: (topic: string, msg: InboundMessage) => void = () => {}
  const send = (method: string) => async (chatId: string, _what: unknown, other: Record<string, unknown> = {}) => {
    if (options.refuse?.includes(method)) throw new Error(`${method} refused`)
    sent.push({ method, chatId, other })
    return { message_id: nextId++ }
  }
  const ports: AskPorts = {
    api: { sendPhoto: send('sendPhoto'), sendDocument: send('sendDocument'), sendMessage: send('sendMessage') } as unknown as AskPorts['api'],
    chatId: '-100',
    target: 'target' in options ? options.target : { kind: 'dedicated' },
    store: { topic: () => stored, save: t => { stored = t } },
    createTopic: async name => {
      created.push(name)
      await Bun.sleep(5)
      if (createFails-- > 0) throw new Error('Bad Request: not enough rights to create a topic')
      return '77'
    },
    routeTopic: (topic, route) => routed.push([topic, route]),
    refusal: topic => (topic === '900' ? 'the square cannot take asks' : undefined),
    ensureSession: () => {},
    enqueue: (topic, msg) => {
      queued.push([topic, msg])
      onEnqueue(topic, msg)
    },
    saveImage: (_bytes, kind) => `/inbox/1-ask.${kind}`,
    transcribe: async () => ('transcript' in options ? options.transcript! : 'what is this'),
    log: () => {},
  }
  const service = createAsk(ports)
  return {
    service,
    sent,
    created,
    routed,
    queued,
    stored: () => stored,
    answerWith: (fn: typeof onEnqueue) => { onEnqueue = fn },
  }
}

const image = { bytes: new Uint8Array([1]), kind: 'png' as const }
const asking = (s: Partial<AskSubmission> = {}): AskSubmission => ({ question: 'what is this?', waitMs: 0, ...s })

describe('the ask topic', () => {
  test('a dedicated topic is created once, kept, and started on Sonnet', async () => {
    const h = harness()
    await Promise.all([h.service.ask(asking()), h.service.ask(asking())])
    await h.service.ask(asking())
    expect(h.created).toEqual(['ask'])
    expect(h.stored()).toBe('77')
    expect(h.routed.map(([t, r]) => [t, r.model])).toEqual([['77', 'sonnet']])
    expect(h.queued.map(([t]) => t)).toEqual(['77', '77', '77'])
  })

  test('a configured topic is used as it is, its route untouched', async () => {
    const h = harness({ target: { kind: 'configured', topic: 'general' } })
    const answered = await h.service.ask(asking())
    expect(answered.topic).toBe('general')
    expect(h.created).toEqual([])
    expect(h.routed).toEqual([])
    expect(h.sent[0].other.message_thread_id).toBeUndefined()
  })

  test('a malformed target or a topic that cannot take asks is refused', async () => {
    await expect(harness({ target: undefined }).service.ask(asking())).rejects.toMatchObject({ reason: 'unavailable' })
    const square = harness({ target: { kind: 'configured', topic: '900' } })
    await expect(square.service.ask(asking())).rejects.toMatchObject({ reason: 'unavailable' })
    expect(square.sent).toEqual([])
  })
})

describe('the post', () => {
  test('carries the screenshot with the question as its caption, and the turn replies to it', async () => {
    const h = harness()
    const answered = await h.service.ask(asking({ image, url: 'https://example.com/p' }))
    expect(h.sent).toEqual([{
      method: 'sendPhoto',
      chatId: '-100',
      other: { message_thread_id: 77, caption: 'You asked: what is this?\nhttps://example.com/p' },
    }])
    const [, turn] = h.queued[0]
    expect(turn.meta).toMatchObject({ ask: '1', message_id: String(answered.messageId), image_path: '/inbox/1-ask.png' })
  })

  test('a screenshot Telegram refuses goes as a document, then the question alone', async () => {
    const asDocument = harness({ refuse: ['sendPhoto'] })
    await asDocument.service.ask(asking({ image }))
    expect(asDocument.sent.map(s => s.method)).toEqual(['sendDocument'])
    const alone = harness({ refuse: ['sendPhoto', 'sendDocument'] })
    await alone.service.ask(asking({ image }))
    expect(alone.sent.map(s => s.method)).toEqual(['sendMessage'])
  })

  test('a topic Telegram will not create fails the ask, and the next ask tries again', async () => {
    const h = harness({ createFails: 1 })
    await expect(h.service.ask(asking())).rejects.toMatchObject({ reason: 'unposted' })
    expect(h.stored()).toBeUndefined()
    expect((await h.service.ask(asking())).topic).toBe('77')
    expect(h.created).toEqual(['ask', 'ask'])
  })

  test('an ask that cannot be posted at all fails, and nothing is queued', async () => {
    const h = harness({ refuse: ['sendMessage'] })
    await expect(h.service.ask(asking())).rejects.toMatchObject({ reason: 'unposted' })
    expect(h.queued).toEqual([])
  })
})

describe('the question', () => {
  test('a recording is transcribed when there is no text', async () => {
    const h = harness()
    const answered = await h.service.ask({ audio: new Uint8Array([1]), waitMs: 0 })
    expect(answered.question).toBe('what is this')
    expect(h.queued[0][1].meta.voice_transcribed).toBe('1')
  })

  test('a recording that yields nothing is refused before anything is posted', async () => {
    const h = harness({ transcript: null })
    const refused = await h.service.ask({ audio: new Uint8Array([1]), waitMs: 0 }).catch(e => e)
    expect(refused).toBeInstanceOf(AskRefused)
    expect(refused.reason).toBe('unintelligible')
    expect(h.sent).toEqual([])
    expect(h.created).toEqual([])
  })
})

describe('the answer', () => {
  test('the first reply to the post within the wait is the answer, however fast it comes', async () => {
    const h = harness()
    h.answerWith((topic, msg) => {
      h.service.replied(topic, Number(msg.meta.message_id), 'It is a cat.')
      h.service.replied(topic, Number(msg.meta.message_id), 'A second reply.')
    })
    expect((await h.service.ask(asking({ waitMs: 1_000 }))).answer).toBe('It is a cat.')
  })

  test('a reply to another post, in another topic, or without reply_to is not the answer', async () => {
    const h = harness()
    h.answerWith((topic, msg) => {
      const id = Number(msg.meta.message_id)
      h.service.replied(topic, id + 1, 'another post')
      h.service.replied('general', id, 'another topic')
      h.service.replied(topic, undefined, 'no reply_to')
    })
    const started = Date.now()
    expect((await h.service.ask(asking({ waitMs: 150 }))).answer).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })
})
