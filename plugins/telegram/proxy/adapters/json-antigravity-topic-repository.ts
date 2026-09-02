import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import { antigravityTopicFromRecord } from '../domain/antigravity-topic'
import type {
  AntigravityTopic,
  AntigravityTopicRepository,
} from '../domain/antigravity-topic'

type StoredTopics = {
  version: 1
  topics: AntigravityTopic[]
}

const clone = (topic: AntigravityTopic): AntigravityTopic => structuredClone(topic)

export class JsonAntigravityTopicRepository implements AntigravityTopicRepository {
  private readonly topics = new Map<string, AntigravityTopic>()

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredTopics
    if (parsed.version !== 1 || !Array.isArray(parsed.topics)) {
      throw new Error(`unsupported Antigravity topic state in ${file}`)
    }
    for (const raw of parsed.topics) {
      const topic = antigravityTopicFromRecord(raw)
      if (!topic) throw new Error(`invalid Antigravity topic state in ${file}`)
      this.topics.set(topic.topic, topic)
    }
  }

  list(): AntigravityTopic[] {
    return [...this.topics.values()].map(clone)
  }

  get(topic: string): AntigravityTopic | undefined {
    const current = this.topics.get(topic)
    return current ? clone(current) : undefined
  }

  save(topic: AntigravityTopic): void {
    this.topics.set(topic.topic, clone(topic))
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
