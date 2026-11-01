// Brings a Telegram Desktop export of the forum group into the conductor's
// store as history (docs/conductor.md, "Imported history"). A dry run unless
// told to write:
//
//   bun conductor/telegram-import.ts <export dir> --store <conductor dir>
//     --registry <registry.json> --operator-id <user id> [--bot-id <user id>]
//     [--exclude <topic>]... [--write]
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { ImportedMessage } from './domain/message'
import { readExport } from './domain/telegram-export'
import type { ExportMessage, ImportEntry } from './domain/telegram-export'
import { ConductorStore } from './sqlite-store'

/** What the plan needs to know of the store. */
export type StoreView = Pick<ConductorStore, 'chatIdIndex' | 'lowestSeq'>

export type PlannedMessage = { entry: ImportEntry; id: string; seq: number; replyTo: string | null }

export type TopicTally = { added: number; alreadyStored: number; media: number; first: string; last: string }

export type ImportPlan = { messages: PlannedMessage[]; topics: Map<string, TopicTally> }

/** Stable per Telegram message, so a second run finds what the first stored. */
export const importedId = (chatId: number) =>
  `msg_${createHash('sha256').update(`telegram:${chatId}`).digest('hex').slice(0, 20)}`

/**
 * Numbers what is not stored yet below each topic's lowest seq, oldest first,
 * so a topic reads in time order from its imported start into its live messages.
 */
export function planImport(entries: readonly ImportEntry[], store: StoreView): ImportPlan {
  const stored = store.chatIdIndex()
  const topics = new Map<string, TopicTally>()
  const tally = (topic: string, at: string) => {
    const t = topics.get(topic) ?? { added: 0, alreadyStored: 0, media: 0, first: at, last: at }
    if (at < t.first) t.first = at
    if (at > t.last) t.last = at
    topics.set(topic, t)
    return t
  }
  const fresh = new Map<string, ImportEntry[]>()
  for (const entry of entries) {
    const t = tally(entry.topic, entry.at)
    if (stored.has(entry.chatId)) {
      t.alreadyStored++
      continue
    }
    t.added++
    t.media += entry.media.length
    const list = fresh.get(entry.topic)
    if (list) list.push(entry)
    else fresh.set(entry.topic, [entry])
  }
  const ids = new Map(stored)
  for (const list of fresh.values()) for (const e of list) ids.set(e.chatId, importedId(e.chatId))
  const messages: PlannedMessage[] = []
  for (const [topic, list] of fresh) {
    list.sort((a, b) => a.at.localeCompare(b.at) || a.chatId - b.chatId)
    const floor = Math.min(store.lowestSeq(topic) ?? 1, 1)
    list.forEach((entry, i) => messages.push({
      entry,
      id: importedId(entry.chatId),
      seq: floor - list.length + i,
      replyTo: entry.replyToChatId === null ? null : ids.get(entry.replyToChatId) ?? null,
    }))
  }
  return { messages, topics }
}

/** Writes the plan in batches, each with its media; a missing media file is left out and counted. */
export function writePlan(plan: ImportPlan, store: ConductorStore, exportDir: string, batch = 200): { added: number; missingMedia: number } {
  const root = resolve(exportDir) + sep
  let added = 0
  let missingMedia = 0
  for (let i = 0; i < plan.messages.length; i += batch) {
    const rows: ImportedMessage[] = plan.messages.slice(i, i + batch).map(({ entry, id, seq, replyTo }) => {
      const blobs = entry.media.flatMap(media => {
        const path = resolve(exportDir, media.path)
        if (!path.startsWith(root) || !existsSync(path)) {
          missingMedia++
          return []
        }
        return [store.addBlob(readFileSync(path), media.mime)]
      })
      return {
        id, topic: entry.topic, seq, author: entry.author, kind: entry.kind, text: entry.text, format: entry.format,
        replyTo, chatIds: [entry.chatId], at: entry.at, editedAt: entry.editedAt, blobs,
      }
    })
    added += store.importMessages(rows)
  }
  return { added, missingMedia }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function main(args: string[]): void {
  const exportDir = args[0]
  const storeDir = flag(args, '--store')
  const registryFile = flag(args, '--registry')
  const operatorId = flag(args, '--operator-id')
  if (!exportDir || !storeDir || !registryFile || !operatorId) {
    throw new Error('usage: telegram-import.ts <export dir> --store <dir> --registry <file> --operator-id <id> [--bot-id <id>] [--exclude <topic>]... [--write]')
  }
  const write = args.includes('--write')
  const exclude = new Set(args.flatMap((a, i) => (a === '--exclude' && args[i + 1] ? [args[i + 1]] : [])))
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as Record<string, { name?: string }>
  const names = new Map(Object.entries(registry).map(([topic, e]) => [topic, e.name ?? topic]))
  const exported = JSON.parse(readFileSync(join(exportDir, 'result.json'), 'utf8')) as { messages: ExportMessage[] }
  const reading = readExport(exported.messages, {
    operatorId, botId: flag(args, '--bot-id'), topics: new Set(['general', ...names.keys()]), exclude,
  })

  const store = new ConductorStore(storeDir, { readOnly: !write })
  const plan = planImport(reading.entries, store)
  const authors = new Map<string, Record<string, number>>()
  for (const { entry } of plan.messages) {
    const key = entry.kind ? `${entry.author}:${entry.kind}` : entry.author
    const counts = authors.get(entry.topic) ?? {}
    counts[key] = (counts[key] ?? 0) + 1
    authors.set(entry.topic, counts)
  }
  console.log(write ? 'WRITING' : 'DRY RUN (nothing written; --write to import)')
  console.log('skipped:', Object.entries(reading.skipped).filter(([, n]) => n).map(([why, n]) => `${why} ${n}`).join(', ') || 'none')
  for (const root of reading.unknownRoots) {
    console.log(`not a known topic: ${root.topic} "${root.title}", ${root.messages} messages, ${root.operatorMessages} from the operator`)
  }
  const rows = [...plan.topics].sort((a, b) => b[1].added - a[1].added)
  for (const [topic, t] of rows) {
    const who = Object.entries(authors.get(topic) ?? {}).map(([k, n]) => `${k} ${n}`).join(', ')
    console.log(`${topic.padStart(7)} ${(names.get(topic) ?? topic).padEnd(26)} add ${String(t.added).padStart(5)}  stored ${String(t.alreadyStored).padStart(3)}  media ${String(t.media).padStart(4)}  ${t.first.slice(0, 10)}..${t.last.slice(0, 10)}  ${who}`)
  }
  console.log(`total to add: ${plan.messages.length}`)
  if (!write) return
  const result = writePlan(plan, store, exportDir)
  console.log(`added ${result.added}, media files missing ${result.missingMedia}, history since ${store.historySince()}`)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

