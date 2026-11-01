import { existsSync, readFileSync } from 'fs'
import { writeJsonAtomic } from '../shared/json-file'
import { deletableNow, sentBy } from './domain/sent-messages'
import type { SentMessage } from './domain/sent-messages'

type StoredSentMessages = { version: 1; messages: SentMessage[] }

const valid = (m: unknown): m is SentMessage => {
  const r = m as Record<string, unknown> | null
  return !!r && typeof r.topic === 'string' && Number.isSafeInteger(r.id) && Number.isFinite(r.at)
}

/** Each topic's sent messages, kept in a file so a restart cannot strand a message its agent must delete. */
export class JsonSentMessages {
  private messages: SentMessage[] = []

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredSentMessages
    if (parsed.version !== 1 || !Array.isArray(parsed.messages) || !parsed.messages.every(valid)) {
      throw new Error(`unsupported sent message state in ${file}`)
    }
    this.messages = deletableNow(parsed.messages, this.now())
  }

  record(topic: string, ids: readonly number[]): void {
    if (!ids.length) return
    const at = this.now()
    this.messages = [...deletableNow(this.messages, at), ...ids.map(id => ({ topic, id, at }))]
    this.persist()
  }

  sentBy(topic: string, id: number): boolean {
    return sentBy(this.messages, topic, id, this.now())
  }

  forget(topic: string, id: number): void {
    this.messages = this.messages.filter(m => !(m.topic === topic && m.id === id))
    this.persist()
  }

  private persist(): void {
    writeJsonAtomic(this.file, { version: 1, messages: this.messages } satisfies StoredSentMessages)
  }
}
