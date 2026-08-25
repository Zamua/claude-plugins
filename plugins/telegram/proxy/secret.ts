// Secret drop: parse "/secret <name>" + value, store it as a private file.
// No Telegram here, so the rules are testable without a bot.

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

export const SECRET_CMD_RE = /^\/secret(?:@\w+)?(?=\s|$)/

// Lowercase file-name characters only: the name becomes a path component and
// must never carry a separator, a leading dot, or a parent reference.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export type ParsedSecret = { name: string; value: string } | { error: string }

// `/secret NAME` with the value as the rest of the message (same line or the
// following lines). Surrounding whitespace is dropped: a paste from a phone
// usually carries a stray newline, and no secret legitimately starts with one.
export function parseSecretCommand(text: string): ParsedSecret {
  const body = text.replace(SECRET_CMD_RE, '')
  const m = /^\s*(\S+)([\s\S]*)$/.exec(body)
  if (!m) return { error: 'usage: /secret <name> then the value on the next line' }
  const name = m[1]
  if (!NAME_RE.test(name) || name.includes('..')) {
    return { error: `refused name "${name}": use lowercase letters, digits, dot, dash, underscore` }
  }
  const value = m[2].trim()
  if (!value) return { error: `no value for "${name}": put it on the line after the name` }
  return { name, value }
}

export type StoredSecret = { path: string; bytes: number; replaced: boolean }

// Private from the first byte: the temp file is created 0600 (then chmod'ed,
// since writeFileSync's mode is subject to umask) and renamed into place, so a
// reader never sees a partial value and a crash leaves no world-readable file.
export function storeSecret(dir: string, name: string, value: string): StoredSecret {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, name)
  const tmp = join(dir, `.${name}.tmp-${process.pid}`)
  const replaced = existsSync(path)
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
