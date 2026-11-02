import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeConversationExists, transcriptTails } from './claude-transcript'

describe('claudeConversationExists', () => {
  const dirs: string[] = []
  const configDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-config-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('finds a conversation in any project directory', () => {
    const dir = configDir()
    mkdirSync(join(dir, 'projects', '-Users-someone'), { recursive: true })
    mkdirSync(join(dir, 'projects', '-Users-someone-work'), { recursive: true })
    writeFileSync(join(dir, 'projects', '-Users-someone-work', 'abc-123.jsonl'), '{}\n')
    expect(claudeConversationExists('abc-123', dir)).toBeTrue()
  })

  test('reports a conversation whose file is gone', () => {
    const dir = configDir()
    mkdirSync(join(dir, 'projects', '-Users-someone'), { recursive: true })
    expect(claudeConversationExists('abc-123', dir)).toBeFalse()
  })

  test('treats a missing projects directory as no conversation', () => {
    expect(claudeConversationExists('abc-123', configDir())).toBeFalse()
  })

  test('rejects ids that could escape the projects directory', () => {
    const dir = configDir()
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    writeFileSync(join(dir, 'secret.jsonl'), '{}\n')
    expect(claudeConversationExists('../secret', dir)).toBeFalse()
  })
})

describe('transcriptTails', () => {
  test('the last bytes of a transcript as lines, read again only once it changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-config-'))
    try {
      mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
      const file = join(dir, 'projects', 'p', 'abc-1.jsonl')
      writeFileSync(file, 'first line\nsecond\nthird\n')
      const tail = transcriptTails(dir, 16)
      expect(tail('abc-1')).toEqual(['ne', 'second', 'third'])
      expect(tail('abc-1')).toBe(tail('abc-1'))
      appendFileSync(file, 'fourth\n')
      expect(tail('abc-1')).toEqual(['nd', 'third', 'fourth'])
      expect(tail('missing')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
