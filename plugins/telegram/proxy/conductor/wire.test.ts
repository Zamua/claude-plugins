// The API's shapes against the contract's golden fixtures: a drift on either
// side fails here and in the app's own tests.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { StoredMessage } from './domain/message'
import { wireApproval, wireDevice, wireMessage, wireRoutes, wireScreen, wireTopic, wireUsage } from './wire'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'docs', 'conductor-v1', name), 'utf8'))

const messageFrom = (f: Record<string, any>): StoredMessage => ({
  id: f.id, topic: f.topic, seq: f.seq, author: f.author, origin: f.origin, kind: f.kind, text: f.text,
  format: f.format, blobs: f.blobs, replyTo: f.reply_to, chatIds: [], at: f.at, editedAt: f.edited_at,
  reactions: f.reactions, clientId: f.client_id ?? null, delivery: f.delivery ?? null, failure: f.failure ?? null,
  imported: f.imported ?? false,
})

describe('the wire matches the contract fixtures', () => {
  for (const name of ['message-agent.json', 'message-reminder.json', 'message-ask.json', 'message-imported.json']) {
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
      route: f.route, lastMessage: f.last_message, role: f.role, projectId: f.project_id, parentId: f.parent_id, spawnedBy: f.spawned_by, spawnedAt: f.spawned_at, archivedAt: null,
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

test('screen.json: hc reports no cursor, so a screen carries none', () => {
  const f = fixture('screen.json')
  expect(wireScreen({ topic: f.topic, rows: f.rows, cols: f.cols, working: f.working })).toEqual(f)
})

test('routes.json: each provider with the models it can run, as the picker offers them', () => {
  const f = fixture('routes.json')
  const opus = f.providers[0].models[0]
  const wire = wireRoutes({
    anthropic: [{ id: opus.id, label: opus.label, efforts: opus.efforts, defaultEffort: opus.default_effort }, { id: 'old', label: 'Old', efforts: ['low'], defaultEffort: 'low', bridgeSupported: false }],
    codex: [],
    'opencode-go': [],
  }) as { providers: unknown[] }
  expect(wire.providers[0]).toEqual(f.providers[0])
  expect(wire.providers.map(p => (p as { id: string }).id)).toEqual(['anthropic', 'codex', 'opencode-go'])
})

test('a catalog for a caller that may not pick every provider marks each one operator_only or not', () => {
  const wire = wireRoutes({ anthropic: [], codex: [], 'opencode-go': [] }, provider => provider === 'codex') as { providers: Array<{ id: string; operator_only: boolean }> }
  expect(wire.providers.map(p => [p.id, p.operator_only])).toEqual([['anthropic', false], ['codex', true], ['opencode-go', false]])
})

test('usage.json: the observed windows, with a reset as a time and an unknown share as null', () => {
  const f = fixture('usage.json')
  const w = f.providers[0].windows[0]
  expect(wireUsage([{ provider: 'anthropic', availability: 'available', observedAt: 0, windows: [{ name: w.name, usedPercent: w.used_percent, resetsAt: Date.parse(w.resets_at), availability: 'available' }] }])).toEqual(f)
  expect(wireUsage([{ provider: 'codex', availability: 'unknown', observedAt: 0, windows: [{ name: 'week', availability: 'unknown' }] }]))
    .toEqual({ providers: [{ id: 'codex', windows: [{ name: 'week', used_percent: null, resets_at: null }] }] })
})

test('topics-projects.json: one root, every project under it, every worker under its project\'s coordinator, nothing deeper', () => {
  const { topics } = fixture('topics-projects.json') as { topics: Array<{ id: string; role: string; project_id: string | null; parent_id: string | null }> }
  const byId = new Map(topics.map(t => [t.id, t]))
  expect(topics.filter(t => t.role === 'root').map(t => [t.id, t.parent_id, t.project_id])).toEqual([['general', null, null]])
  for (const t of topics.filter(t => t.role === 'coordinator')) expect([t.parent_id, t.project_id]).toEqual(['general', t.id])
  for (const t of topics.filter(t => t.role === 'worker')) {
    expect(byId.get(t.parent_id as string)?.role).toBe('coordinator')
    expect(t.project_id).toBe(t.parent_id)
  }
})

for (const name of ['approval-open.json', 'approval-resolved.json']) {
  test(name, () => {
    const f = fixture(name)
    expect(wireApproval({ id: f.id, topic: f.topic, kind: f.kind, prompt: f.prompt, choices: f.choices, createdAt: f.created_at, resolved: f.resolved })).toEqual(f)
  })
}

