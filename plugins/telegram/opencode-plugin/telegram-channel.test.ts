import { describe, expect, test } from 'bun:test'
import { isIdleEvent, renderChannel, textFromParts } from './telegram-channel'

describe('opencode event adapter', () => {
  test('recognizes session.idle with the SDK event shape', () => {
    expect(isIdleEvent({ type: 'session.idle', properties: { sessionID: 'ses_x' } }, 'ses_x')).toBe(true)
    expect(isIdleEvent({ type: 'session.idle', properties: { sessionID: 'ses_y' } }, 'ses_x')).toBe(false)
  })

  test('recognizes idle session.status events and ignores busy status', () => {
    expect(
      isIdleEvent(
        { type: 'session.status', properties: { sessionID: 'ses_x', status: { type: 'idle' } } },
        'ses_x',
      ),
    ).toBe(true)
    expect(
      isIdleEvent(
        { type: 'session.status', properties: { sessionID: 'ses_x', status: { type: 'busy' } } },
        'ses_x',
      ),
    ).toBe(false)
    expect(isIdleEvent({ type: 'idle', sessionID: 'ses_x' }, 'ses_x')).toBe(false)
  })

  test('renders channel metadata and escapes attribute delimiters', () => {
    expect(renderChannel('hello', { chat_id: '123', user: 'a"b', line: 'x\ny' })).toBe(
      '<channel source="plugin:telegram:telegram" chat_id="123" user="a&quot;b" line="x y">\nhello\n</channel>',
    )
  })

  test('extracts text parts while ignoring tool parts', () => {
    expect(textFromParts([{ type: 'tool' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }])).toBe(
      'first\nsecond',
    )
  })
})
