import { describe, expect, test } from 'bun:test'
import { topicSlug } from './topic-slug'

describe('topicSlug', () => {
  test('lowercases and joins words with single dashes', () => {
    expect(topicSlug('Claude Plugins: v2.0')).toBe('claude-plugins-v2-0')
  })

  test('falls back to "topic" when no letters or digits survive', () => {
    expect(topicSlug('!!!')).toBe('topic')
    expect(topicSlug('')).toBe('topic')
  })

  test('caps the length without leaving a trailing dash at the cut', () => {
    expect(topicSlug('a'.repeat(40))).toBe('a'.repeat(24))
    expect(topicSlug(`${'a'.repeat(23)} bcd`)).toBe('a'.repeat(23))
  })
})
