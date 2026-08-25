// Secret drop: parse "/secret <name> [--replace]" + value, "/secrets",
// "/unsecret <name>", drive the guided flow a bare command opens, and keep the
// files. No Telegram here, so the rules are testable without a bot.

import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

// Three flat verbs, because Telegram's "/" menu has no sub-commands and a
// phone keyboard mangles "--": /secret stores, /secrets lists, /unsecret
// deletes. The --list / --delete flag forms stay as aliases.
export const SECRET_CMD_RE = /^\/(secret|secrets|unsecret)(?:@\w+)?(?=\s|$)/

// Lowercase file-name characters only: the name becomes a path component and
// must never carry a separator, a leading dot, or a parent reference.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

// A phone keyboard turns "--" into an em or en dash, so a flag accepts either.
const FLAG_RE = /^(?:--|[—–])(\w+)$/
const REPLACE_RE = /^\s+(?:--|[—–])replace(?=\s|$)/
const REPLACE_WORD_RE = /^(?:--|[—–])replace$/

const USAGE = 'usage: /secret <name> then the value on the next line; /secrets; /unsecret <name>'

export type SecretVerb = 'secret' | 'unsecret'

export type SecretCommand =
  | { kind: 'store'; name: string; value: string; replace: boolean }
  | { kind: 'list' }
  | { kind: 'delete'; name: string }
  | { kind: 'begin'; verb: SecretVerb }
  | { error: string }

function nameError(name: string): string | null {
  if (!name) return USAGE
  if (!NAME_RE.test(name) || name.includes('..')) {
    return `refused name "${name}": use lowercase letters, digits, dot, dash, underscore`
  }
  return null
}

// The store form takes the value as the rest of the message (same line or the
// following lines). `--replace` counts only directly after the name; anywhere
// else it is part of the value. Surrounding whitespace is dropped: a paste
// from a phone usually carries a stray newline, and no secret legitimately
// starts with one. A bare /secret or /unsecret is what the "/" menu sends on
// a tap, so it begins the guided flow instead of failing with usage.
export function parseSecretCommand(text: string): SecretCommand {
  const verb = SECRET_CMD_RE.exec(text)?.[1]
  if (!verb) return { error: USAGE }
  const body = text.replace(SECRET_CMD_RE, '')
  if (verb === 'secrets') return { kind: 'list' }
  if (!body.trim()) return { kind: 'begin', verb }
  if (verb === 'unsecret') return deleteForm(body)
  const m = /^\s*(\S+)([\s\S]*)$/.exec(body)
  if (!m) return { error: USAGE }
  const [, first, rest] = m
  const flag = FLAG_RE.exec(first)?.[1]
  if (flag === 'list') return { kind: 'list' }
  if (flag === 'delete') return deleteForm(rest)
  if (flag) return { error: `unknown flag --${flag}. ${USAGE}` }
  const bad = nameError(first)
  if (bad) return { error: bad }
  const rep = REPLACE_RE.exec(rest)
  const value = (rep ? rest.slice(rep[0].length) : rest).trim()
  if (!value) return { error: `no value for "${first}": put it on the line after the name` }
  return { kind: 'store', name: first, value, replace: !!rep }
}

function deleteForm(rest: string): SecretCommand {
  const name = rest.trim().split(/\s+/)[0] ?? ''
  const bad = nameError(name)
  return bad ? { error: bad } : { kind: 'delete', name }
}

// ---- guided flow -------------------------------------------------------------
// A bare command opens a two-step exchange: name, then value (or just the
// name for a delete). Pure: the caller owns the pending state, sends the
// prompts, and performs the resulting store or delete.

export type Pending =
  | { step: 'name'; verb: 'secret' }
  | { step: 'value'; verb: 'secret'; name: string; replace: boolean }
  | { step: 'name'; verb: 'unsecret' }

export type FlowResult =
  | { kind: 'prompt'; next: Pending; text: string; placeholder: string }
  | { kind: 'store'; name: string; value: string; replace: boolean }
  | { kind: 'delete'; name: string }
  | { kind: 'cancelled' }

export function beginSecretFlow(verb: SecretVerb): FlowResult {
  return verb === 'secret'
    ? prompt({ step: 'name', verb }, 'Name for the secret? (or "cancel")', 'name, e.g. cloudflare-foo-dns')
    : prompt({ step: 'name', verb }, 'Which secret to delete? (or "cancel")', 'name')
}

// `exists` is asked at the name step so an existing name is refused BEFORE the
// value is requested: nobody should paste a secret only to have it bounced.
export function advanceSecretFlow(p: Pending, text: string, exists: (name: string) => boolean): FlowResult {
  const t = text.trim()
  if (/^\/?cancel$/i.test(t)) return { kind: 'cancelled' }
  if (p.step === 'value') return { kind: 'store', name: p.name, value: t, replace: p.replace }
  const [name = '', flag = ''] = t.split(/\s+/)
  const bad = nameError(name)
  if (bad) return prompt(p, `${bad}. Try again, or "cancel".`, 'name')
  if (p.verb === 'unsecret') return { kind: 'delete', name }
  const replace = REPLACE_WORD_RE.test(flag)
  if (exists(name) && !replace) {
    return prompt(p, `"${name}" exists. Send "${name} --replace" to overwrite it, another name, or "cancel".`, 'name')
  }
  return prompt(
    { step: 'value', verb: 'secret', name, replace },
    `Value for ${name}? Paste it; the message is deleted once stored.`,
    'paste the value',
  )
}

function prompt(next: Pending, text: string, placeholder: string): FlowResult {
  return { kind: 'prompt', next, text: `🔐 ${text}`, placeholder }
}

// ---- files -------------------------------------------------------------------

export class SecretExists extends Error {
  constructor(public readonly bytes: number) {
    super('secret exists')
    this.name = 'SecretExists'
  }
}

export class SecretMissing extends Error {
  constructor() {
    super('no such secret')
    this.name = 'SecretMissing'
  }
}

export function secretExists(dir: string, name: string): boolean {
  assertName(name)
  return existsSync(join(dir, name))
}

export type StoredSecret = { path: string; bytes: number; replaced: boolean }

// Refuses an existing name unless told to replace it: the directory holds live
// credentials, and a mistyped name must not silently clobber one. Private from
// the first byte: the temp file is created 0600 (then chmod'ed, since
// writeFileSync's mode is subject to umask) and renamed into place, so a
// reader never sees a partial value and a crash leaves no world-readable file.
export function storeSecret(dir: string, name: string, value: string, replace = false): StoredSecret {
  assertName(name)
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

export type SecretEntry = { name: string; bytes: number; mtime: Date }

// Names, sizes and dates only. Dotfiles are skipped: that is where a temp file
// or an unrelated marker would live, never a secret.
export function listSecrets(dir: string): SecretEntry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.'))
    .map(d => {
      const path = join(dir, d.name)
      return { name: d.name, bytes: storedBytes(path), mtime: statSync(path).mtime }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function deleteSecret(dir: string, name: string): { bytes: number } {
  assertName(name)
  const path = join(dir, name)
  if (!existsSync(path)) throw new SecretMissing()
  const bytes = storedBytes(path)
  rmSync(path)
  return { bytes }
}

// The parser already validates; this keeps a direct caller from passing a path.
function assertName(name: string): void {
  const bad = nameError(name)
  if (bad) throw new Error(bad)
}

// Size as the ack reports it: the value without the trailing newline the file carries.
function storedBytes(path: string): number {
  const buf = readFileSync(path)
  return buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length
}
