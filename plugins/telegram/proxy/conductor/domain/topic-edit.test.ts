import { expect, test } from 'bun:test'
import { NAME_MAX, topicName, topicPatch } from './topic-edit'

test('a name is trimmed and at most Telegram\'s 128 characters, counted as characters', () => {
  expect(topicName('  build ')).toBe('build')
  expect(topicName('é'.repeat(NAME_MAX))).toBe('é'.repeat(NAME_MAX))
  expect(topicName('x'.repeat(NAME_MAX + 1))).toMatchObject({ code: 'bad_name' })
  expect(topicName('  ')).toMatchObject({ code: 'bad_name' })
  expect(topicName(7)).toMatchObject({ code: 'bad_name' })
})

test('a patch takes the fields it names, each of its own type, and at least one', () => {
  expect(topicPatch({ name: 'ci', muted: true })).toEqual({ name: 'ci', muted: true })
  expect(topicPatch({ pinned: false })).toEqual({ pinned: false })
  expect(topicPatch({ muted: 'yes' })).toMatchObject({ code: 'bad_muted' })
  expect(topicPatch({ name: '' })).toMatchObject({ code: 'bad_name' })
  expect(topicPatch({ other: 1 })).toMatchObject({ code: 'empty' })
})
