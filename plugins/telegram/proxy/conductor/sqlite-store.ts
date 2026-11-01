// The conductor's store: every message in every topic, numbered gaplessly per
// topic, and an event log whose cursor a client resumes from. Blobs are kept by
// content, so the same image stored twice is one file.
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BlobRef, NewMessage, StoredEvent, StoredMessage } from './domain/message'
import type { Device } from './wire'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  seq INTEGER NOT NULL,
  author TEXT NOT NULL,
  origin TEXT NOT NULL,
  kind TEXT,
  text TEXT NOT NULL,
  format TEXT NOT NULL,
  reply_to TEXT,
  chat_ids TEXT NOT NULL,
  at TEXT NOT NULL,
  edited_at TEXT,
  reactions TEXT NOT NULL DEFAULT '[]',
  client_id TEXT,
  delivery TEXT,
  failure TEXT,
  UNIQUE (topic, seq)
);
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER, height INTEGER);
CREATE TABLE IF NOT EXISTS message_blobs (message_id TEXT NOT NULL, blob_id TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY (message_id, ord));
CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, topic TEXT NOT NULL, ref TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL,
  apns_token TEXT, apns_env TEXT, enrolled_at TEXT NOT NULL, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS read_state (topic TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS writes (
  device TEXT NOT NULL, client_id TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  status INTEGER NOT NULL, response TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (device, client_id)
);
`

type MessageRow = {
  id: string; topic: string; seq: number; author: string; origin: string; kind: string | null; text: string
  format: string; reply_to: string | null; chat_ids: string; at: string; edited_at: string | null; reactions: string
  client_id: string | null; delivery: string | null; failure: string | null
}

type DeviceRow = {
  id: string; name: string; public_key: string; node_id: string; apns_token: string | null
  apns_env: Device['apnsEnv']; enrolled_at: string; last_seen: string | null
}

export class ConductorStore {
  private readonly db: Database
  private readonly blobDir: string
  private readonly listeners: Array<(event: StoredEvent) => void> = []

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.blobDir = join(dir, 'blobs')
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 })
    this.db = new Database(join(dir, 'conductor.db'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  /** Stores the message and its event in one transaction, taking the topic's next seq. */
  append(message: NewMessage): StoredMessage {
    const stored = this.db.transaction(() => {
      const { next } = this.db
        .query('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE topic = ?')
        .get(message.topic) as { next: number }
      const id = `msg_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const at = message.at ?? new Date().toISOString()
      this.db
        .query('INSERT INTO messages (id, topic, seq, author, origin, kind, text, format, reply_to, chat_ids, at, client_id, delivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, message.topic, next, message.author, message.origin, message.kind ?? null, message.text, message.format,
          message.replyTo ?? null, JSON.stringify(message.chatIds ?? []), at, message.clientId ?? null, message.delivery ?? null)
      ;(message.blobs ?? []).forEach((blob, ord) =>
        this.db.query('INSERT INTO message_blobs (message_id, blob_id, ord) VALUES (?, ?, ?)').run(id, blob.id, ord))
      const { lastInsertRowid } = this.db.query("INSERT INTO events (type, topic, ref) VALUES ('message', ?, ?)").run(message.topic, id)
      return { cursor: Number(lastInsertRowid), type: 'message' as const, message: this.message(id) as StoredMessage }
    })()
    for (const listener of this.listeners) listener(stored)
    return stored.message
  }

  /** Records whether an app message reached its agent, and announces the message again. */
  setDelivery(id: string, delivery: 'delivered' | 'failed', failure?: string): StoredMessage | undefined {
    const stored = this.db.transaction(() => {
      const row = this.db.query('SELECT topic FROM messages WHERE id = ?').get(id) as { topic: string } | null
      if (!row) return undefined
      this.db.query('UPDATE messages SET delivery = ?, failure = ? WHERE id = ?').run(delivery, failure ?? null, id)
      const { lastInsertRowid } = this.db.query("INSERT INTO events (type, topic, ref) VALUES ('message', ?, ?)").run(row.topic, id)
      return { cursor: Number(lastInsertRowid), type: 'message' as const, message: this.message(id) as StoredMessage }
    })()
    if (stored) for (const listener of this.listeners) listener(stored)
    return stored?.message
  }

  /** Read markers are shared by every device and never move back. */
  markRead(topic: string, seq: number): number {
    this.db
      .query('INSERT INTO read_state (topic, seq) VALUES (?, ?) ON CONFLICT (topic) DO UPDATE SET seq = MAX(seq, excluded.seq)')
      .run(topic, seq)
    return this.summary(topic).readSeq
  }

  /** A device's earlier write under this client id, kept so a retry gets the first answer. */
  earlierWrite(device: string, clientId: string): { bodySha256: string; status: number; response: string } | undefined {
    const row = this.db
      .query('SELECT body_sha256, status, response FROM writes WHERE device = ? AND client_id = ?')
      .get(device, clientId) as { body_sha256: string; status: number; response: string } | null
    return row ? { bodySha256: row.body_sha256, status: row.status, response: row.response } : undefined
  }

  recordWrite(device: string, clientId: string, bodySha256: string, status: number, response: string): void {
    this.db
      .query('INSERT OR IGNORE INTO writes (device, client_id, body_sha256, status, response, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(device, clientId, bodySha256, status, response, new Date().toISOString())
  }

  /** Called with each event once it is stored. */
  onEvent(listener: (event: StoredEvent) => void): void {
    this.listeners.push(listener)
  }

  latestCursor(): number {
    return (this.db.query('SELECT COALESCE(MAX(cursor), 0) AS c FROM events').get() as { c: number }).c
  }

  /** The topic's newest message, and how many messages after `readSeq` are not the operator's. */
  summary(topic: string): { last: StoredMessage | undefined; unread: number; readSeq: number } {
    const readSeq = (this.db.query('SELECT seq FROM read_state WHERE topic = ?').get(topic) as { seq: number } | null)?.seq ?? 0
    const { n } = this.db
      .query("SELECT COUNT(*) AS n FROM messages WHERE topic = ? AND seq > ? AND author != 'operator'")
      .get(topic, readSeq) as { n: number }
    return { last: this.history(topic, 1)[0], unread: n, readSeq }
  }

  /** Stores a new device, or gives the one already enrolled with this key. */
  enroll(device: Omit<Device, 'id' | 'enrolledAt' | 'lastSeen'>, at = new Date().toISOString()): { device: Device; created: boolean } {
    const existing = this.db.query('SELECT * FROM devices WHERE public_key = ?').get(device.publicKey) as DeviceRow | null
    if (existing) return { device: this.deviceFrom(existing), created: false }
    const id = `dev_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    this.db
      .query('INSERT INTO devices (id, name, public_key, node_id, apns_token, apns_env, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, device.name, device.publicKey, device.nodeId, device.apnsToken, device.apnsEnv, at)
    return { device: this.device(id) as Device, created: true }
  }

  device(id: string): Device | undefined {
    const row = this.db.query('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | null
    return row ? this.deviceFrom(row) : undefined
  }

  touchDevice(id: string, at = new Date().toISOString()): void {
    this.db.query('UPDATE devices SET last_seen = ? WHERE id = ?').run(at, id)
  }

  blobPath(id: string): { path: string; mime: string } | undefined {
    const row = this.db.query('SELECT mime FROM blobs WHERE id = ?').get(id) as { mime: string } | null
    return row ? { path: join(this.blobDir, id), mime: row.mime } : undefined
  }

  private deviceFrom(row: DeviceRow): Device {
    return {
      id: row.id, name: row.name, publicKey: row.public_key, nodeId: row.node_id, apnsToken: row.apns_token,
      apnsEnv: row.apns_env, enrolledAt: row.enrolled_at, lastSeen: row.last_seen,
    }
  }

  /** Keeps the bytes once, named by their hash, and gives the reference a message carries. */
  addBlob(bytes: Uint8Array, mime: string): BlobRef {
    const id = `blob_${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`
    const path = join(this.blobDir, id)
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 })
    this.db.query('INSERT OR IGNORE INTO blobs (id, mime, bytes) VALUES (?, ?, ?)').run(id, mime, bytes.length)
    return { id, mime, bytes: bytes.length, width: null, height: null }
  }

  /** A topic's messages, newest first, before `beforeSeq` when given. */
  history(topic: string, limit: number, beforeSeq?: number): StoredMessage[] {
    const rows = this.db
      .query('SELECT * FROM messages WHERE topic = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(topic, beforeSeq ?? Number.MAX_SAFE_INTEGER, Math.min(Math.max(limit, 1), 100)) as MessageRow[]
    return rows.map(row => this.fromRow(row))
  }

  /** Every event after `cursor`, oldest first. */
  eventsAfter(cursor: number, limit = 500): StoredEvent[] {
    const rows = this.db
      .query('SELECT cursor, type, ref FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?')
      .all(cursor, limit) as Array<{ cursor: number; type: 'message'; ref: string }>
    return rows.flatMap(row => {
      const message = this.message(row.ref)
      return message ? [{ cursor: row.cursor, type: row.type, message }] : []
    })
  }

  close(): void {
    this.db.close()
  }

  messageById(id: string): StoredMessage | undefined {
    return this.message(id)
  }

  private message(id: string): StoredMessage | undefined {
    const row = this.db.query('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | null
    return row ? this.fromRow(row) : undefined
  }

  private fromRow(row: MessageRow): StoredMessage {
    const blobs = this.db
      .query('SELECT b.id, b.mime, b.bytes, b.width, b.height FROM message_blobs m JOIN blobs b ON b.id = m.blob_id WHERE m.message_id = ? ORDER BY m.ord')
      .all(row.id) as BlobRef[]
    return {
      id: row.id, topic: row.topic, seq: row.seq,
      author: row.author as StoredMessage['author'], origin: row.origin as StoredMessage['origin'],
      kind: row.kind as StoredMessage['kind'], text: row.text, format: row.format as StoredMessage['format'],
      blobs, replyTo: row.reply_to, chatIds: JSON.parse(row.chat_ids), at: row.at,
      editedAt: row.edited_at, reactions: JSON.parse(row.reactions),
      clientId: row.client_id, delivery: row.delivery as StoredMessage['delivery'], failure: row.failure,
    }
  }
}
