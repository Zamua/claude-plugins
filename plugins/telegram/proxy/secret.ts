// Secret drop: parse "/secret <name> [--replace]" + value, store it as a
// private file. No Telegram here, so the rules are testable without a bot.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

export const SECRET_CMD_RE = /^\/secret(?:@\w+)?(?=\s|$)/

// Lowercase file-name characters only: the name becomes a path component and
// must never carry a separator, a leading dot, or a parent reference.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export type ParsedSecret = { name: string; value: string; replace: boolean } | { error: string }

// `/secret NAME [--replace]` with the value as the rest of the message (same
// line or the following lines). `--replace` counts only directly after the
// name; anywhere else it is part of the value. Surrounding whitespace is
// dropped: a paste from a phone usually carries a stray newline, and no secret
// legitimately starts with one.
export function parseSecretCommand(text: string): ParsedSecret {
  const body = text.replace(SECRET_CMD_RE, '')
  const m = /^\s*(\S+)([\s\S]*)$/.exec(body)
  if (!m) return { error: 'usage: /secret <name> then the value on the next line' }
  const name = m[1]
  if (!NAME_RE.test(name) || name.includes('..')) {
    return { error: `refused name "${name}": use lowercase letters, digits, dot, dash, underscore` }
  }
  const replace = /^\s+--replace(?=\s|$)/.test(m[2])
  const value = (replace ? m[2].replace(/^\s+--replace/, '') : m[2]).trim()
  if (!value) return { error: `no value for "${name}": put it on the line after the name` }
  return { name, value, replace }
}

export class SecretExists extends Error {
  constructor(public readonly bytes: number) {
    super('secret exists')
    this.name = 'SecretExists'
  }
}

export type StoredSecret = { path: string; bytes: number; replaced: boolean }

// Refuses an existing name unless told to replace it: the directory holds live
// credentials, and a mistyped name must not silently clobber one. Private from
// the first byte: the temp file is created 0600 (then chmod'ed, since
// writeFileSync's mode is subject to umask) and renamed into place, so a
// reader never sees a partial value and a crash leaves no world-readable file.
export function storeSecret(dir: string, name: string, value: string, replace = false): StoredSecret {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, name)
  const replaced = existsSync(path)
  if (replaced && !replace) throw new SecretExists(storedBytes(path))
  const tmp = join(dir, `.${name}.tmp-${process.pid}`)
  try {
    writeFileSync(tmp, value + '\n', { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (err) {
    try { rmSync(tmp) } catch {}
    throw err
  }
  return { path, bytes: Buffer.byteLength(value), replaced }
}

// Size as the ack reports it: the value without the trailing newline the file carries.
function storedBytes(path: string): number {
  const buf = readFileSync(path)
  return buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length
}
