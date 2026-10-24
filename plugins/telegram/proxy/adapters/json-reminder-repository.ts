import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { Reminder } from '../domain/reminder'

type StoredReminders = {
  version: 1
  reminders: Reminder[]
}

export class JsonReminderRepository {
  private readonly reminders = new Map<string, Reminder>()

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredReminders
    if (parsed.version !== 1 || !Array.isArray(parsed.reminders)) {
      throw new Error(`unsupported reminder state in ${file}`)
    }
    for (const r of parsed.reminders) this.reminders.set(r.id, r)
  }

  list(): Reminder[] {
    return [...this.reminders.values()].map(r => ({ ...r }))
  }

  add(r: Reminder): void {
    this.reminders.set(r.id, { ...r })
    this.persist()
  }

  remove(id: string): boolean {
    if (!this.reminders.delete(id)) return false
    this.persist()
    return true
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    const state: StoredReminders = { version: 1, reminders: [...this.reminders.values()] }
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, this.file)
  }
}
