import { existsSync, readFileSync } from 'fs'
import { writeJsonAtomic } from './json-file'

type StoredTopics<T> = {
  version: 1
  topics: T[]
}

/**
 * The versioned `{version: 1, topics: [...]}` file shared by every
 * harness-locked topic kind. A file this cannot fully parse throws, so a
 * harness never boots with topics silently dropped.
 */
export class JsonTopicRepository<T extends { topic: string }> {
  private readonly topics = new Map<string, T>()

  constructor(
    private readonly file: string,
    label: string,
    fromRecord: (value: unknown) => T | undefined,
  ) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredTopics<unknown>
    if (parsed?.version !== 1 || !Array.isArray(parsed.topics)) {
      throw new Error(`unsupported ${label} topic state in ${file}`)
    }
    for (const raw of parsed.topics) {
      const topic = fromRecord(raw)
      if (!topic) throw new Error(`invalid ${label} topic state in ${file}`)
      this.topics.set(topic.topic, topic)
    }
  }

  list(): T[] {
    return [...this.topics.values()].map(t => structuredClone(t))
  }

  get(topic: string): T | undefined {
    const current = this.topics.get(topic)
    return current ? structuredClone(current) : undefined
  }

  save(topic: T): void {
    this.topics.set(topic.topic, structuredClone(topic))
    const state: StoredTopics<T> = { version: 1, topics: [...this.topics.values()] }
    writeJsonAtomic(this.file, state)
  }
}
