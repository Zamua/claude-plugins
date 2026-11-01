// A Telegram Desktop JSON export of the forum group, read as the conductor's
// messages. Pure: the caller reads the files and writes the store.
import type { Author, MessageFormat, MessageKind } from './message'

/** One entry of an export's `text`: a plain run, or a run carrying one entity. */
export type ExportPart = string | { type: string; text: string; href?: string; language?: string }

export type ExportMessage = {
  id: number
  type: string
  date_unixtime?: string
  edited_unixtime?: string
  action?: string
  title?: string
  from_id?: string
  text?: string | ExportPart[]
  reply_to_message_id?: number
  photo?: string
  file?: string
  mime_type?: string
}

export type ExportMedia = { path: string; mime: string }

export type ImportEntry = {
  chatId: number
  topic: string
  at: string
  editedAt: string | null
  author: Author
  kind: MessageKind
  text: string
  format: MessageFormat
  media: ExportMedia[]
  /** The Telegram id of the message it answers, inside its topic. */
  replyToChatId: number | null
}

export type SkipReason = 'excluded topic' | 'unknown topic' | 'unknown sender' | 'app echo' | 'no topic root'

export type ExportReading = {
  entries: ImportEntry[]
  skipped: Record<SkipReason, number>
  /** Topic roots the export holds that are not known topics, with how many operator messages each holds. */
  unknownRoots: Array<{ topic: string; title: string; operatorMessages: number; messages: number }>
}

export type ReadOptions = {
  /** The operator's Telegram user id. */
  operatorId: string
  /** The bot's user id; absent, the one sender who is not the operator. */
  botId?: string
  /** Topic ids that exist, `general` included. */
  topics: ReadonlySet<string>
  exclude: ReadonlySet<string>
}

/** Bot messages the proxy posts itself, by how they open; anything else the bot posted is an agent's. */
const PROXY_OPENINGS = [
  /^🤖 \S+ (·|→)/u, /^↪️ asked @/u, /^↩︎/u, /^⚠️ /u, /^🚨 /u, /^✅ (Fleet Health|Usage window)/u, /^😞 /u,
  /^🗂 deps digest/u, /^Security news watch/, /^Now using /, /^♻️ /u, /^🗜️ /u, /^Approval needed/, /^🔐 /u, /^📱 /u,
  /^Could not start this topic/,
]
const REMINDER = /^⏰ /u
const ASK_POST = /^You asked: /
const APP_ECHO = /^You \(app\): /

/** Entities that are markup; links, mentions and the like Telegram detects again from the text. */
const MARKUP = new Set(['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code', 'pre', 'text_link', 'blockquote'])

const escapeV2 = (text: string) => text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => `\\${c}`)
const escapeCode = (text: string) => text.replace(/[`\\]/g, c => `\\${c}`)

function partToV2(part: ExportPart): string {
  if (typeof part === 'string') return escapeV2(part)
  const t = part.text
  switch (part.type) {
    case 'bold': return `*${escapeV2(t)}*`
    case 'italic': return `_${escapeV2(t)}_`
    case 'underline': return `__${escapeV2(t)}__`
    case 'strikethrough': return `~${escapeV2(t)}~`
    case 'spoiler': return `||${escapeV2(t)}||`
    case 'code': return `\`${escapeCode(t)}\``
    case 'pre': return `\`\`\`${part.language ?? ''}\n${escapeCode(t)}\n\`\`\``
    case 'text_link': return `[${escapeV2(t)}](${(part.href ?? '').replace(/[)\\]/g, c => `\\${c}`)})`
    case 'blockquote': return escapeV2(t).split('\n').map(line => `>${line}`).join('\n')
    default: return escapeV2(t)
  }
}

/** The text as written: plain when it carries no markup, else Telegram MarkdownV2, as the bot sends. */
export function exportText(text: string | ExportPart[] | undefined): { text: string; format: MessageFormat } {
  if (text === undefined) return { text: '', format: 'plain' }
  if (typeof text === 'string') return { text, format: 'plain' }
  if (!text.some(p => typeof p !== 'string' && MARKUP.has(p.type))) {
    return { text: text.map(p => (typeof p === 'string' ? p : p.text)).join(''), format: 'plain' }
  }
  return { text: text.map(partToV2).join(''), format: 'markdownv2' }
}

const plainOf = (text: string | ExportPart[] | undefined) =>
  text === undefined ? '' : typeof text === 'string' ? text : text.map(p => (typeof p === 'string' ? p : p.text)).join('')

const iso = (unix: string | undefined) => new Date(Number(unix) * 1000).toISOString()

function mediaOf(m: ExportMessage): ExportMedia[] {
  if (m.photo) return [{ path: m.photo, mime: 'image/jpeg' }]
  if (m.file) return [{ path: m.file, mime: m.mime_type ?? 'application/octet-stream' }]
  return []
}

/**
 * Reads the export. A message's topic is the root its reply chain reaches (a
 * `topic_created` service message, whose id is the thread id); a message with
 * no reply is in general.
 */
export function readExport(messages: readonly ExportMessage[], options: ReadOptions): ExportReading {
  const byId = new Map(messages.map(m => [m.id, m]))
  const roots = new Map(messages.filter(m => m.action === 'topic_created').map(m => [m.id, m.title ?? '']))
  const operator = `user${options.operatorId}`
  const senders = new Set(messages.filter(m => m.type === 'message' && m.from_id !== operator).map(m => m.from_id))
  const bot = options.botId ? `user${options.botId}` : senders.size === 1 ? [...senders][0] : undefined
  if (!bot) throw new Error(`the export has ${senders.size} senders besides the operator; name the bot`)

  const topicOf = (m: ExportMessage): string | undefined => {
    const seen = new Set<number>()
    let current = m
    for (;;) {
      if (roots.has(current.id)) return String(current.id)
      const parent = current.reply_to_message_id
      if (parent === undefined) return 'general'
      if (roots.has(parent)) return String(parent)
      const next = byId.get(parent)
      if (!next || seen.has(parent)) return undefined
      seen.add(parent)
      current = next
    }
  }

  const skipped: Record<SkipReason, number> = { 'excluded topic': 0, 'unknown topic': 0, 'unknown sender': 0, 'app echo': 0, 'no topic root': 0 }
  const unknown = new Map<string, { operatorMessages: number; messages: number }>()
  const entries: ImportEntry[] = []
  for (const m of messages) {
    if (m.type !== 'message') continue
    const topic = topicOf(m)
    if (topic === undefined) { skipped['no topic root']++; continue }
    if (options.exclude.has(topic)) { skipped['excluded topic']++; continue }
    if (!options.topics.has(topic)) {
      const counts = unknown.get(topic) ?? { operatorMessages: 0, messages: 0 }
      counts.messages++
      if (m.from_id === operator) counts.operatorMessages++
      unknown.set(topic, counts)
      skipped['unknown topic']++
      continue
    }
    if (m.from_id !== operator && m.from_id !== bot) { skipped['unknown sender']++; continue }
    const plain = plainOf(m.text)
    if (m.from_id === bot && APP_ECHO.test(plain)) { skipped['app echo']++; continue }
    const { text, format } = exportText(m.text)
    const author: Author = m.from_id === operator ? 'operator' : PROXY_OPENINGS.some(p => p.test(plain)) || REMINDER.test(plain) || ASK_POST.test(plain) ? 'proxy' : 'agent'
    const kind: MessageKind = author !== 'proxy' ? null : REMINDER.test(plain) ? 'reminder' : ASK_POST.test(plain) ? 'ask' : null
    const parent = m.reply_to_message_id
    entries.push({
      chatId: m.id, topic, at: iso(m.date_unixtime), editedAt: m.edited_unixtime ? iso(m.edited_unixtime) : null,
      author, kind, text, format, media: mediaOf(m),
      replyToChatId: parent !== undefined && !roots.has(parent) ? parent : null,
    })
  }
  const unknownRoots = [...roots]
    .filter(([id]) => !options.topics.has(String(id)) && !options.exclude.has(String(id)))
    .map(([id, title]) => ({ topic: String(id), title, ...(unknown.get(String(id)) ?? { operatorMessages: 0, messages: 0 }) }))
  return { entries, skipped, unknownRoots }
}
