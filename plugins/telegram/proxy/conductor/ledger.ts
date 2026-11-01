// The ledger of operator acts (docs/conductor.md): one JSON object per line,
// each carrying the hash of the line before it, so a removed, changed or
// reordered line breaks the chain. Lines are only ever appended.
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'fs'
import { sha256Hex } from './domain/signing'

const GENESIS = 'genesis'

export type LedgerEntry = { kind: string } & Record<string, unknown>

const hashOf = (prev: string, body: Record<string, unknown>) => sha256Hex(`${prev}\n${JSON.stringify(body)}`)

export class Ledger {
  private last: string

  constructor(private readonly path: string) {
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
    this.last = lines.length ? JSON.parse(lines[lines.length - 1]).hash : GENESIS
  }

  /** Writes the act to disk before returning, so nothing acts on an unrecorded act. */
  append(entry: LedgerEntry, at = new Date().toISOString()): string {
    const body = { ...entry, at, prev: this.last }
    const hash = hashOf(this.last, body)
    const fd = openSync(this.path, 'a', 0o600)
    try {
      appendFileSync(fd, `${JSON.stringify({ ...body, hash })}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.last = hash
    return hash
  }
}

/** The first line whose chain does not hold, counted from 1, or undefined when every line does. */
export function brokenLine(text: string): number | undefined {
  let prev = GENESIS
  const lines = text.split('\n').filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    const { hash, ...body } = JSON.parse(lines[i])
    if (body.prev !== prev || hashOf(prev, body) !== hash) return i + 1
    prev = hash
  }
  return undefined
}
