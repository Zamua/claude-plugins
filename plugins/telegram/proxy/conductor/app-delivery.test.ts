import { describe, expect, test } from 'bun:test'
import type { InboundMsg } from '../topics/state'
import { appDelivery } from './app-delivery'
import type { StoredMessage } from './domain/message'

const message = { id: 'msg_1', topic: '42', seq: 3, text: 'run the tests', at: '2026-11-01T20:25:37.123Z' } as StoredMessage

function harness(over: Partial<Parameters<typeof appDelivery>[0]> = {}) {
  const queued: Array<[string, InboundMsg]> = []
  const order: string[] = []
  const echoed: string[] = []
  const deliver = appDelivery({
    operatorId: '4242',
    chatId: '-1007770000001',
    refuses: () => undefined,
    saveImage: (_bytes, ext) => `/inbox/app.${ext}`,
    ensureSession: topic => order.push(`ensure ${topic}`),
    enqueue: (topic, msg) => {
      order.push(`enqueue ${topic}`)
      queued.push([topic, msg])
    },
    echo: async (_topic, text) => {
      echoed.push(text)
      return 901
    },
    ...over,
  })
  return { deliver, queued, order, echoed }
}

describe('appDelivery', () => {
  test('an app message is echoed into Telegram and queued as the operator\'s turn, marked with its device and ledger entry', async () => {
    const h = harness()
    const outcome = await h.deliver({ topic: '42', message, images: [], ledgerHash: 'abc', deviceId: 'dev_1' })
    expect(outcome).toEqual({ delivered: true })
    expect(h.echoed).toEqual(['You (app): run the tests'])
    expect(h.order).toEqual(['ensure 42', 'enqueue 42'])
    expect(h.queued[0][1]).toEqual({
      content: 'run the tests',
      meta: {
        chat_id: '-1007770000001', message_id: '901', user: 'operator (app)', user_id: '4242',
        ts: message.at, message_thread_id: '42', origin: 'app', device: 'dev_1', ledger: 'abc',
      },
    })
  })

  test('images are saved for the agent to read: the first as its image, the rest named in the text', async () => {
    const h = harness()
    const jpeg = { bytes: new Uint8Array([1]), mime: 'image/jpeg' as const }
    const png = { bytes: new Uint8Array([2]), mime: 'image/png' as const }
    await h.deliver({ topic: 'general', message, images: [jpeg, png], ledgerHash: 'h', deviceId: 'd' })
    const turn = h.queued[0][1]
    expect(turn.meta.image_path).toBe('/inbox/app.jpg')
    expect(turn.content).toBe('run the tests\n(more images: /inbox/app.png)')
    expect(turn.meta.message_thread_id).toBeUndefined()
    expect(h.echoed).toEqual(['You (app): run the tests [2 images]'])
  })

  test('a topic that takes no turns from here gets nothing, and the reason is reported', async () => {
    const h = harness({ refuses: () => 'the topic is locked to another harness' })
    expect(await h.deliver({ topic: '42', message, images: [], ledgerHash: 'h', deviceId: 'd' })).toEqual({ delivered: false, reason: 'the topic is locked to another harness' })
    expect(h.queued).toEqual([])
    expect(h.echoed).toEqual([])
  })

  test('a Telegram echo that fails still delivers the turn, without a message id', async () => {
    const h = harness({ echo: async () => { throw new Error('Telegram down') } })
    expect(await h.deliver({ topic: '42', message, images: [], ledgerHash: 'h', deviceId: 'd' })).toEqual({ delivered: true })
    expect(h.queued[0][1].meta.message_id).toBeUndefined()
  })
})
