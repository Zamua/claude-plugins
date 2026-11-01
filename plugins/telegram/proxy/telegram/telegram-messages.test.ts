import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertSendable, chunk, describeMessage } from './telegram-messages'

describe('telegram messages', () => {
  test('long text splits on Telegram\'s limit and keeps every character', () => {
    expect(chunk('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
    expect(chunk('abc', 3)).toEqual(['abc'])
  })

  test('an uploader-named file cannot break out of the channel meta', () => {
    const d = describeMessage({ document: { file_id: 'f', file_name: 'a"><x>;b\n.txt' } })
    expect(d?.attachment?.name).toBe('a"__x__b_.txt')
  })

  test('a photo is described by its largest size and its caption', () => {
    const d = describeMessage({ caption: 'look', photo: [{ file_id: 's', file_unique_id: 'u1' }, { file_id: 'l', file_unique_id: 'u2' }] })
    expect(d).toEqual({ content: 'look', photo: { file_id: 'l', file_unique_id: 'u2' } })
  })

  test('a service message is not relayed', () => {
    expect(describeMessage({ forum_topic_created: { name: 'x' } })).toBeNull()
  })

  test('the proxy\'s own state and token files are refused, its inbox is not', () => {
    const state = mkdtempSync(join(tmpdir(), 'tg-state-'))
    mkdirSync(join(state, 'inbox'))
    for (const name of ['registry.json', '.env', 'inbox/photo.jpg']) writeFileSync(join(state, name), 'x')
    const other = join(mkdtempSync(join(tmpdir(), 'tg-other-')), 'plugin.env')
    writeFileSync(other, 'TOKEN=x')
    expect(() => assertSendable(join(state, 'registry.json'), state, [])).toThrow('channel state')
    expect(() => assertSendable(other, '/nonexistent', [other])).toThrow('credential file')
    expect(() => assertSendable(join(state, 'inbox', 'photo.jpg'), state, [other])).not.toThrow()
  })
})
