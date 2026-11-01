import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeJsonAtomic } from './json-file'

const freshDir = () => mkdtempSync(join(tmpdir(), 'json-file-'))

describe('writeJsonAtomic', () => {
  test('creates missing parent directories and writes the file owner-only', () => {
    const file = join(freshDir(), 'nested', 'state.json')
    writeJsonAtomic(file, { a: 1 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('replaces an existing file and leaves no temp file beside it', () => {
    const dir = freshDir()
    const file = join(dir, 'state.json')
    writeFileSync(file, '{"old": true}')
    writeJsonAtomic(file, { new: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ new: true })
    expect(readdirSync(dir)).toEqual(['state.json'])
  })

  test('a failed write leaves the old file and no temp file', () => {
    const dir = freshDir()
    const file = join(dir, 'state.json')
    mkdirSync(file)
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow()
    expect(readdirSync(dir)).toEqual(['state.json'])
    expect(statSync(file).isDirectory()).toBeTrue()
  })
})
