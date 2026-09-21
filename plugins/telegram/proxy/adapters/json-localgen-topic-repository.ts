import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import { localgenTopicFromRecord } from '../domain/localgen-topic'
import type { LocalgenTopic, LocalgenTopicRepository } from '../domain/localgen-topic'

type StoredTopics = {
  version: 1
  topics: LocalgenTopic[]
}

export class JsonLocalgenTopicRepository implements LocalgenTopicRepository {
  private readonly topics = new Map<string, LocalgenTopic>()

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredTopics
    if (parsed.version !== 1 || !Array.isArray(parsed.topics)) {
      throw new Error(`unsupported localgen topic state in ${file}`)
    }
    for (const raw of parsed.topics) {
      const topic = localgenTopicFromRecord(raw)
      if (!topic) throw new Error(`invalid localgen topic state in ${file}`)
      this.topics.set(topic.topic, topic)
    }
  }

  list(): LocalgenTopic[] {
    return [...this.topics.values()].map(topic => ({ ...topic }))
  }

  get(topic: string): LocalgenTopic | undefined {
    const current = this.topics.get(topic)
    return current ? { ...current } : undefined
  }

  save(topic: LocalgenTopic): void {
    this.topics.set(topic.topic, { ...topic })
    this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    const state: StoredTopics = { version: 1, topics: [...this.topics.values()] }
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, this.file)
  }
}
