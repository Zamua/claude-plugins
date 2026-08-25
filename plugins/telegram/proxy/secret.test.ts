import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SECRET_CMD_RE, parseSecretCommand, storeSecret } from './secret'

describe('parseSecretCommand', () => {
  test('name on the command line, value on the next', () => {
    expect(parseSecretCommand('/secret cloudflare-foo-dns\nabc123\n')).toEqual({
      name: 'cloudflare-foo-dns',
      value: 'abc123',
    })
  })

  test('value on the same line, and a multi-line value, both survive intact', () => {
    expect(parseSecretCommand('/secret k v1')).toEqual({ name: 'k', value: 'v1' })
    expect(parseSecretCommand('/secret pem\n-----BEGIN\nline2\n-----END\n\n')).toEqual({
      name: 'pem',
      value: '-----BEGIN\nline2\n-----END',
    })
  })

  test('the @botname suffix Telegram appends to commands is ignored', () => {
    expect(SECRET_CMD_RE.test('/secret@mybot k')).toBe(true)
    expect(parseSecretCommand('/secret@mybot k\nv')).toEqual({ name: 'k', value: 'v' })
    expect(SECRET_CMD_RE.test('/secrets k')).toBe(false)
  })

  test('a name that could escape the directory is refused', () => {
    for (const bad of ['../x', 'a/b', '.hidden', 'a..b', 'Upper', 'x'.repeat(65), '']) {
      const parsed = parseSecretCommand(`/secret ${bad}\nv`)
      expect('error' in parsed).toBe(true)
    }
  })

  test('a missing value is refused rather than stored empty', () => {
    expect(parseSecretCommand('/secret k')).toEqual({ error: 'no value for "k": put it on the line after the name' })
    expect(parseSecretCommand('/secret k\n   \n')).toMatchObject({ error: expect.stringContaining('no value') })
    expect(parseSecretCommand('/secret')).toMatchObject({ error: expect.stringContaining('usage') })
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

  test('overwriting reports replaced and leaves the new value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-'))
    storeSecret(dir, 'k', 'old')
    const stored = storeSecret(dir, 'k', 'new')

    expect(stored.replaced).toBe(true)
    expect(readFileSync(stored.path, 'utf8')).toBe('new\n')
    expect(statSync(stored.path).mode & 0o777).toBe(0o600)
  })

  test('creates a missing directory privately', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'secret-')), 'keys')
    storeSecret(dir, 'k', 'v')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})
