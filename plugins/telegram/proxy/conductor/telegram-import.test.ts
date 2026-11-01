import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ImportEntry } from './domain/telegram-export'
import { ConductorStore } from './sqlite-store'
import { importedId, planImport, writePlan } from './telegram-import'
import { wireMessage } from './wire'

const open: ConductorStore[] = []
afterEach(() => open.splice(0).forEach(s => s.close()))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'import-'))
  const store = new ConductorStore(join(dir, 'store'))
  open.push(store)
  const exportDir = join(dir, 'export')
  mkdirSync(join(exportDir, 'photos'), { recursive: true })
  writeFileSync(join(exportDir, 'photos', 'p.jpg'), new Uint8Array([0xff, 0xd8, 1]))
  return { store, exportDir }
}

const entry = (chatId: number, topic: string, minute: number, over: Partial<ImportEntry> = {}): ImportEntry => ({
  chatId, topic, at: new Date(Date.UTC(2026, 9, 30, 12, minute)).toISOString(), editedAt: null, author: 'agent', kind: null,
  text: `m${chatId}`, format: 'plain', media: [], replyToChatId: null, ...over,
})

test('history goes below each topic\'s live messages, oldest first, without events, unread or a second copy', () => {
  const { store, exportDir } = setup()
  const events: unknown[] = []
  store.onEvent(e => void events.push(e))
  store.append({ topic: '7', author: 'agent', origin: 'proxy', text: 'live', format: 'plain', chatIds: [500] })
  events.length = 0
  const cursor = store.latestCursor()

  const entries = [
    entry(402, '7', 2, { replyToChatId: 401 }), entry(401, '7', 1, { author: 'operator' }), entry(500, '7', 9),
    entry(403, '7', 3, { replyToChatId: 500, media: [{ path: 'photos/p.jpg', mime: 'image/jpeg' }, { path: '../outside.jpg', mime: 'image/jpeg' }] }),
    entry(301, 'general', 0),
  ]
  const plan = planImport(entries, store)
  expect(plan.topics.get('7')).toMatchObject({ added: 3, alreadyStored: 1, media: 2 })
  expect(writePlan(plan, store, exportDir)).toEqual({ added: 4, missingMedia: 1 })

  const seven = store.history('7', 10).reverse()
  expect(seven.map(m => [m.text, m.seq, m.imported])).toEqual([['m401', -2, true], ['m402', -1, true], ['m403', 0, true], ['live', 1, false]])
  expect(seven.map(m => m.replyTo)).toEqual([null, importedId(401), seven[3].id, null])
  expect(seven[2].blobs.map(b => b.mime)).toEqual(['image/jpeg'])
  expect(wireMessage(seven[0])).toMatchObject({ author: 'operator', origin: 'telegram', imported: true })
  expect(wireMessage(seven[3])).not.toHaveProperty('imported')
  expect(store.history('general', 10).map(m => m.seq)).toEqual([0])

  expect([events, store.latestCursor(), store.unreadIn(['7', 'general'])]).toEqual([[], cursor, 1])
  expect(store.historySince()).toBe(entries[4].at)
  expect(planImport(entries, store).messages).toEqual([])
})

test('a topic holding only history numbers its next live message 1, so it counts as unread', () => {
  const { store, exportDir } = setup()
  writePlan(planImport([entry(1, '9', 0), entry(2, '9', 1)], store), store, exportDir)
  const live = store.append({ topic: '9', author: 'agent', origin: 'proxy', text: 'new', format: 'plain' })
  expect([live.seq, store.unreadIn(['9'])]).toEqual([1, 1])
})

test('a later run with more history numbers it below what is already there', () => {
  const { store, exportDir } = setup()
  writePlan(planImport([entry(5, '9', 5)], store), store, exportDir)
  writePlan(planImport([entry(5, '9', 5), entry(3, '9', 3), entry(4, '9', 4)], store), store, exportDir)
  expect(store.history('9', 10).reverse().map(m => [m.text, m.seq])).toEqual([['m3', -2], ['m4', -1], ['m5', 0]])
})
