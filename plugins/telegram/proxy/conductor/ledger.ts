// The ledger of operator acts (docs/conductor.md): one JSON object per line,
// each carrying the hash of the line before it, so a removed, changed or
// reordered line breaks the chain. Lines are only ever appended. Beside it, the
// exact bytes a device signed, so verify.py can show what the operator said.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'fs'
import { dirname, join } from 'path'
import { sha256Hex } from './domain/signing'

const GENESIS = 'genesis'
/** A text message's body fits; one carrying images is not kept, so it cannot serve as a go. */
export const SIGNED_BODY_MAX = 256 * 1024

export type LedgerEntry = { kind: string } & Record<string, unknown>

const hashOf = (prev: string, body: Record<string, unknown>) => sha256Hex(`${prev}\n${JSON.stringify(body)}`)

export class Ledger {
  private last: string

  constructor(private readonly path: string) {
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
    this.last = lines.length ? JSON.parse(lines[lines.length - 1]).hash : GENESIS
  }

  /** Keeps a signed body under its SHA-256 when it is small enough; says whether it was kept. */
  keepSignedBody(body: Uint8Array): boolean {
    if (body.length > SIGNED_BODY_MAX) return false
    const dir = join(dirname(this.path), 'signed-bodies')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, sha256Hex(body))
    if (existsSync(path)) return true
    const fd = openSync(path, 'w', 0o600)
    try {
      writeSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return true
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
