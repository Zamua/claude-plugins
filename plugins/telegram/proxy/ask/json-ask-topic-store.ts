import { existsSync, readFileSync } from 'fs'
import { writeJsonAtomic } from '../shared/json-file'

type StoredAskTopic = { version: 1; topic: string }

/** The dedicated ask topic the proxy created, kept so every later ask lands in the same one. */
export class JsonAskTopicStore {
  private current: string | undefined

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredAskTopic
    if (parsed.version !== 1 || typeof parsed.topic !== 'string' || !/^\d+$/.test(parsed.topic)) {
      throw new Error(`unsupported ask topic state in ${file}`)
    }
    this.current = parsed.topic
  }

  topic(): string | undefined {
    return this.current
  }

  save(topic: string): void {
    writeJsonAtomic(this.file, { version: 1, topic } satisfies StoredAskTopic)
    this.current = topic
  }
}
