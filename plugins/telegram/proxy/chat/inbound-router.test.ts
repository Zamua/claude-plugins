import { describe, expect, test } from 'bun:test'
import type { ActionIntent, ActionPress } from './domain/actions'
import type { MessageId } from './domain/chat-port'
import type { ChatMessage, Sender } from './domain/inbound'
import { createInboundRouter } from './inbound-router'
import type { InboundPorts } from './inbound-router'

const operator: Sender = { id: '4242', name: 'op', role: 'operator' }
const member: Sender = { id: '7', name: 'm', role: 'member' }

function harness() {
  const said: string[] = []
  const routed: ActionIntent[] = []
  const ports = {
    chat: { download: async () => null, react: async () => {} },
    harnesses: [],
    harnessFor: () => undefined,
    topicHarnessOf: () => 'claude',
    sayIn: async (_c: string, _t: string, text: string) => void said.push(text),
    lifecycle: { enqueue: () => {}, ensureSession: () => {}, relaunch: async () => {} },
    routing: {
      handleModelCommand: async () => {},
      refreshProviderCapacity: async () => {},
      capacityText: () => 'Provider usage',
      handleRouteAction: async (p: ActionPress) => (routed.push(p.intent), true),
    },
    secrets: { handleSecretDrop: async () => {}, pendingSecretFlow: () => undefined, handleSecretStep: async () => {} },
    square: { handleSquareUserMessage: () => {} },
    harnessAction: async () => false,
  } as unknown as InboundPorts
  return { route: createInboundRouter(ports), said, routed }
}

function press(intent: ActionIntent, sender: Sender, topic = '42') {
  const answers: Array<{ text: string; alert?: boolean } | undefined> = []
  const p: ActionPress = {
    intent, topic, sender, text: 'picker', siblings: [intent],
    answer: async f => void answers.push(f), update: async () => {}, clearActions: async () => {},
  }
  return { p, answers }
}

const message = (text: string, sender: Sender): ChatMessage =>
  ({ topic: '42', id: 1 as MessageId, chatId: '-100', sender, at: 0, text, content: text, shape: 'text' })

describe('authority comes from the verified sender', () => {
  test('a member pressing a route button is refused and nothing routes', async () => {
    const h = harness()
    const { p, answers } = press({ kind: 'usage', topic: '42' }, member)
    await h.route({ type: 'action', press: p })
    expect(answers).toEqual([{ text: 'Not authorized.' }])
    expect(h.routed).toEqual([])
  })

  test('the operator\'s press routes, unless the button names another topic', async () => {
    const h = harness()
    await h.route({ type: 'action', press: press({ kind: 'usage', topic: '42' }, operator).p })
    expect(h.routed).toEqual([{ kind: 'usage', topic: '42' }])
    const elsewhere = press({ kind: 'usage', topic: '43' }, operator)
    await h.route({ type: 'action', press: elsewhere.p })
    expect(elsewhere.answers).toEqual([{ text: 'This control belongs to a different Telegram topic.', alert: true }])
  })

  test('any member may answer a permission prompt; a stale one says so', async () => {
    const h = harness()
    const { p, answers } = press({ kind: 'permission', behavior: 'allow', requestId: 'gone' }, member)
    await h.route({ type: 'action', press: p })
    expect(answers).toEqual([{ text: 'No longer pending.' }])
  })

  test('only the operator may read provider usage', async () => {
    const h = harness()
    await h.route({ type: 'message', message: message('/usage', member) })
    await h.route({ type: 'message', message: message('/usage', operator) })
    expect(h.said).toEqual(['Only the operator can inspect provider usage.', 'Provider usage'])
  })
})
