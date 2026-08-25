import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SECRET_CMD_RE, SecretExists, SecretMissing, advanceSecretFlow, beginSecretFlow, deleteSecret, listSecrets,
  parseSecretCommand, secretExists, storeSecret,
} from './secret'
import type { Pending } from './secret'

describe('parseSecretCommand', () => {
  test('name on the command line, value on the next', () => {
    expect(parseSecretCommand('/secret cloudflare-foo-dns\nabc123\n')).toEqual({
      kind: 'store',
      name: 'cloudflare-foo-dns',
      value: 'abc123',
      replace: false,
    })
  })

  test('value on the same line, and a multi-line value, both survive intact', () => {
    expect(parseSecretCommand('/secret k v1')).toEqual({ kind: 'store', name: 'k', value: 'v1', replace: false })
    expect(parseSecretCommand('/secret pem\n-----BEGIN\nline2\n-----END\n\n')).toEqual({
      kind: 'store',
      name: 'pem',
      value: '-----BEGIN\nline2\n-----END',
      replace: false,
    })
  })

  test('--replace counts only directly after the name', () => {
    expect(parseSecretCommand('/secret k --replace\nv')).toMatchObject({ kind: 'store', value: 'v', replace: true })
    expect(parseSecretCommand('/secret k --replace v')).toMatchObject({ kind: 'store', value: 'v', replace: true })
    expect(parseSecretCommand('/secret k\n--replace-me')).toMatchObject({ value: '--replace-me', replace: false })
    expect(parseSecretCommand('/secret k\nv --replace')).toMatchObject({ value: 'v --replace', replace: false })
    expect(parseSecretCommand('/secret k --replace')).toMatchObject({ error: expect.stringContaining('no value') })
  })

  test('a bare verb, which is what a menu tap sends, begins the guided flow', () => {
    expect(parseSecretCommand('/secret')).toEqual({ kind: 'begin', verb: 'secret' })
    expect(parseSecretCommand('/secret@mybot')).toEqual({ kind: 'begin', verb: 'secret' })
    expect(parseSecretCommand('/secret  \n')).toEqual({ kind: 'begin', verb: 'secret' })
    expect(parseSecretCommand('/unsecret')).toEqual({ kind: 'begin', verb: 'unsecret' })
    expect(parseSecretCommand('/secrets')).toEqual({ kind: 'list' })
  })

  test('the native verbs: /secrets lists, /unsecret deletes', () => {
    expect(parseSecretCommand('/secrets@mybot')).toEqual({ kind: 'list' })
    expect(parseSecretCommand('/unsecret k')).toEqual({ kind: 'delete', name: 'k' })
    expect(parseSecretCommand('/unsecret@mybot k')).toEqual({ kind: 'delete', name: 'k' })
    expect(parseSecretCommand('/unsecret ../x')).toMatchObject({ error: expect.stringContaining('refused name') })
  })

  test('the flag aliases still work, with a phone keyboard dash (em or en) read as --', () => {
    expect(parseSecretCommand('/secret --list')).toEqual({ kind: 'list' })
    expect(parseSecretCommand('/secret —list')).toEqual({ kind: 'list' })
    expect(parseSecretCommand('/secret --delete k')).toEqual({ kind: 'delete', name: 'k' })
    expect(parseSecretCommand('/secret –delete k')).toEqual({ kind: 'delete', name: 'k' })
    expect(parseSecretCommand('/secret k —replace\nv')).toMatchObject({ replace: true, value: 'v' })
    expect(parseSecretCommand('/secret --delete')).toMatchObject({ error: expect.stringContaining('usage') })
    expect(parseSecretCommand('/secret --frobnicate')).toMatchObject({ error: expect.stringContaining('unknown flag') })
  })

  test('only the three verbs match, with or without the @botname suffix', () => {
    for (const ok of ['/secret k', '/secret@mybot k', '/secrets', '/unsecret k', '/secret']) {
      expect(SECRET_CMD_RE.test(ok)).toBe(true)
    }
    for (const no of ['/secretive k', '/secretsx', '/unsecrets k', 'secret k', ' /secret k']) {
      expect(SECRET_CMD_RE.test(no)).toBe(false)
    }
    expect(parseSecretCommand('/secretive k')).toMatchObject({ error: expect.stringContaining('usage') })
  })

  test('a name that could escape the directory is refused', () => {
    for (const bad of ['../x', 'a/b', '.hidden', 'a..b', 'Upper', 'x'.repeat(65)]) {
      expect('error' in parseSecretCommand(`/secret ${bad}\nv`)).toBe(true)
      expect('error' in parseSecretCommand(`/unsecret ${bad}`)).toBe(true)
    }
  })

  test('a missing value is refused rather than stored empty', () => {
    expect(parseSecretCommand('/secret k')).toEqual({ error: 'no value for "k": put it on the line after the name' })
    expect(parseSecretCommand('/secret k\n   \n')).toMatchObject({ error: expect.stringContaining('no value') })
  })
})

describe('guided flow', () => {
  const none = () => false
  const nameStep: Pending = { step: 'name', verb: 'secret' }

  test('store: name prompt, then value prompt, then the store', () => {
    const first = beginSecretFlow('secret')
    expect(first).toMatchObject({ kind: 'prompt', next: nameStep, placeholder: expect.stringContaining('name') })

    const second = advanceSecretFlow(nameStep, 'cloudflare-foo-dns\n', none)
    expect(second).toMatchObject({
      kind: 'prompt',
      next: { step: 'value', verb: 'secret', name: 'cloudflare-foo-dns', replace: false },
      placeholder: 'paste the value',
    })

    const third = advanceSecretFlow((second as { next: Pending }).next, '  abc123\n', none)
    expect(third).toEqual({ kind: 'store', name: 'cloudflare-foo-dns', value: 'abc123', replace: false })
  })

  test('an existing name is bounced at the name step, before any value is asked for', () => {
    const exists = (n: string) => n === 'taken'
    const bounced = advanceSecretFlow(nameStep, 'taken', exists)
    expect(bounced).toMatchObject({ kind: 'prompt', next: nameStep, text: expect.stringContaining('--replace') })

    for (const flag of ['--replace', '—replace']) {
      expect(advanceSecretFlow(nameStep, `taken ${flag}`, exists)).toMatchObject({
        kind: 'prompt',
        next: { step: 'value', name: 'taken', replace: true },
      })
    }
  })

  test('a bad name re-prompts at the same step', () => {
    const again = advanceSecretFlow(nameStep, '../x', none)
    expect(again).toMatchObject({ kind: 'prompt', next: nameStep, text: expect.stringContaining('refused name') })
  })

  test('delete: one prompt, then the delete', () => {
    const first = beginSecretFlow('unsecret')
    expect(first).toMatchObject({ kind: 'prompt', next: { step: 'name', verb: 'unsecret' } })
    expect(advanceSecretFlow({ step: 'name', verb: 'unsecret' }, 'k', none)).toEqual({ kind: 'delete', name: 'k' })
  })

  test('cancel works at every step, with or without the slash', () => {
    const valueStep: Pending = { step: 'value', verb: 'secret', name: 'k', replace: false }
    for (const p of [nameStep, valueStep, { step: 'name', verb: 'unsecret' } as Pending]) {
      expect(advanceSecretFlow(p, 'cancel', none)).toEqual({ kind: 'cancelled' })
      expect(advanceSecretFlow(p, '/Cancel', none)).toEqual({ kind: 'cancelled' })
    }
  })

  test('secretExists validates the name before touching the filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    storeSecret(dir, 'k', 'v')
    expect(secretExists(dir, 'k')).toBe(true)
    expect(secretExists(dir, 'nope')).toBe(false)
    expect(() => secretExists(dir, '../x')).toThrow('refused name')
  })
})

describe('storeSecret', () => {
  test('writes the value with one trailing newline, mode 0600, no temp file left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    const stored = storeSecret(dir, 'k', 'hunter2')

    expect(stored).toEqual({ path: join(dir, 'k'), bytes: 7, replaced: false })
    expect(readFileSync(stored.path, 'utf8')).toBe('hunter2\n')
    expect(statSync(stored.path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['k'])
  })

  test('an existing name is refused, reporting its size, and left untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    storeSecret(dir, 'k', 'old')

    let caught: unknown
    try {
      storeSecret(dir, 'k', 'new')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SecretExists)
    expect((caught as SecretExists).bytes).toBe(3)
    expect(readFileSync(join(dir, 'k'), 'utf8')).toBe('old\n')
    expect(readdirSync(dir)).toEqual(['k'])
  })

  test('replace overwrites and reports replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    storeSecret(dir, 'k', 'old')
    const stored = storeSecret(dir, 'k', 'new', true)

    expect(stored.replaced).toBe(true)
    expect(readFileSync(stored.path, 'utf8')).toBe('new\n')
    expect(statSync(stored.path).mode & 0o777).toBe(0o600)
  })

  test('creates a missing directory privately', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'secret-')), 'keys')
    storeSecret(dir, 'k', 'v')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('a direct caller cannot pass a path as the name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    expect(() => storeSecret(dir, '../escape', 'v')).toThrow('refused name')
    expect(() => deleteSecret(dir, '../escape')).toThrow('refused name')
  })
})

describe('listSecrets', () => {
  test('names, value sizes and dates, sorted, dotfiles skipped, no values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    storeSecret(dir, 'zeta', 'zz')
    storeSecret(dir, 'alpha', 'hunter2')
    writeFileSync(join(dir, 'raw-no-newline'), 'abc')
    writeFileSync(join(dir, '.alpha.tmp-999'), 'leftover')

    const entries = listSecrets(dir)

    expect(entries.map(e => [e.name, e.bytes])).toEqual([['alpha', 7], ['raw-no-newline', 3], ['zeta', 2]])
    for (const e of entries) expect(e.mtime).toBeInstanceOf(Date)
    expect(JSON.stringify(entries)).not.toContain('hunter2')
  })

  test('a missing directory lists nothing', () => {
    expect(listSecrets(join(tmpdir(), 'secret-does-not-exist'))).toEqual([])
  })
})

describe('deleteSecret', () => {
  test('removes the file and reports its size; a missing name is a typed error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    storeSecret(dir, 'k', 'hunter2')

    expect(deleteSecret(dir, 'k')).toEqual({ bytes: 7 })
    expect(readdirSync(dir)).toEqual([])
    expect(() => deleteSecret(dir, 'k')).toThrow(SecretMissing)
  })
})
