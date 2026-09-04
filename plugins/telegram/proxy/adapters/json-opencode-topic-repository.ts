import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import { opencodeTopicFromRecord } from '../domain/opencode-topic'
import type {
  OpencodeTopic,
  OpencodeTopicRepository,
} from '../domain/opencode-topic'

type StoredTopics = {
  version: 1
  topics: OpencodeTopic[]
}

const clone = (topic: OpencodeTopic): OpencodeTopic => structuredClone(topic)

export class JsonOpencodeTopicRepository implements OpencodeTopicRepository {
  private readonly topics = new Map<string, OpencodeTopic>()

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredTopics
    if (parsed.version !== 1 || !Array.isArray(parsed.topics)) {
      throw new Error(`unsupported OpenCode topic state in ${file}`)
    }
    for (const raw of parsed.topics) {
      const topic = opencodeTopicFromRecord(raw)
      if (!topic) throw new Error(`invalid OpenCode topic state in ${file}`)
      this.topics.set(topic.topic, topic)
    }
  }

  list(): OpencodeTopic[] {
    return [...this.topics.values()].map(clone)
  }

  get(topic: string): OpencodeTopic | undefined {
    const current = this.topics.get(topic)
    return current ? clone(current) : undefined
  }

  save(topic: OpencodeTopic): void {
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
