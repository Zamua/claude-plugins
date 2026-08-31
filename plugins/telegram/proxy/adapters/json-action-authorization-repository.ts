import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import type {
  ActionAuthorization,
  ActionAuthorizationRepository,
} from '../domain/action-authorization'

type StoredAuthorizations = {
  version: 1
  requests: ActionAuthorization[]
}

function clone(request: ActionAuthorization): ActionAuthorization {
  return structuredClone(request)
}

export class JsonActionAuthorizationRepository implements ActionAuthorizationRepository {
  private readonly requests = new Map<string, ActionAuthorization>()

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredAuthorizations
    if (parsed.version !== 1 || !Array.isArray(parsed.requests)) {
      throw new Error(`unsupported action authorization state in ${file}`)
    }
    for (const request of parsed.requests) this.requests.set(request.id, clone(request))
  }

  list(): ActionAuthorization[] {
    return [...this.requests.values()].map(clone)
  }

  get(id: string): ActionAuthorization | undefined {
    const request = this.requests.get(id)
    return request ? clone(request) : undefined
  }

  save(request: ActionAuthorization): void {
    this.requests.set(request.id, clone(request))
    this.persist()
  }

  remove(id: string): void {
    if (!this.requests.delete(id)) return
    this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    const state: StoredAuthorizations = {
      version: 1,
      requests: [...this.requests.values()],
    }
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, this.file)
  }
}
