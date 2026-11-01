// The API's shapes against the contract's golden fixtures: a drift on either
// side fails here and in the app's own tests.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { StoredMessage } from './domain/message'
import { wireDevice, wireMessage, wireTopic } from './wire'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'docs', 'conductor-v1', name), 'utf8'))

const messageFrom = (f: Record<string, any>): StoredMessage => ({
  id: f.id, topic: f.topic, seq: f.seq, author: f.author, origin: f.origin, kind: f.kind, text: f.text,
  format: f.format, blobs: f.blobs, replyTo: f.reply_to, chatIds: [], at: f.at, editedAt: f.edited_at,
  reactions: f.reactions, clientId: f.client_id ?? null, delivery: f.delivery ?? null, failure: f.failure ?? null,
})

describe('the wire matches the contract fixtures', () => {
  for (const name of ['message-agent.json', 'message-reminder.json', 'message-ask.json']) {
    test(name, () => {
      const f = fixture(name)
      expect(wireMessage(messageFrom(f))).toEqual(f)
    })
  }

  for (const name of ['message-operator.json', 'message-operator-failed.json']) {
    test(name, () => {
      const f = fixture(name)
      expect(wireMessage(messageFrom(f))).toEqual(f)
    })
  }

  test('topic.json', () => {
    const f = fixture('topic.json')
    expect(wireTopic({
      id: f.id, name: f.name, kind: f.kind, title: f.title, pinned: f.pinned, muted: f.muted, state: f.state,
      stateSince: f.state_since, unread: f.unread, readSeq: f.read_seq, pendingApprovals: f.pending_approvals,
      route: f.route, lastMessage: f.last_message,
    })).toEqual(f)
  })

  test('device.json', () => {
    const f = fixture('device.json')
    expect(wireDevice({
      id: f.id, name: f.name, publicKey: f.public_key, nodeId: 'nPHONE', apnsToken: f.apns_token,
      apnsEnv: f.apns_env, enrolledAt: f.enrolled_at, lastSeen: f.last_seen,
    })).toEqual(f)
  })
})

test('an operator message relayed from Telegram reads as delivered, with no client id', () => {
  const f = fixture('message-operator.json')
  const relayed = wireMessage({ ...messageFrom(f), origin: 'telegram', clientId: null, delivery: null })
  expect(relayed).toMatchObject({ origin: 'telegram', client_id: null, delivery: 'delivered' })
})
