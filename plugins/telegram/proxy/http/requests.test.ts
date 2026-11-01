import { describe, expect, test } from 'bun:test'
import {
  BadRequest,
  parseCancelReminder,
  parseEdit,
  parsePermissionRequest,
  parseRateLimit,
  parseReact,
  parseSend,
  parseSquareReply,
  parseTopicCreate,
  parseTurnFailed,
} from './requests'

const rejects = (parse: () => unknown, field: string) => {
  expect(parse).toThrow(BadRequest)
  expect(parse).toThrow(field)
}

describe('proxy HTTP request bodies', () => {
  test('a reply from the MCP parses with its defaults', () => {
    expect(parseSend({ chat_id: '-1001', topic: '42', text: 'hi' })).toEqual({
      chatId: '-1001', topic: '42', text: 'hi', files: [], markdown: false,
    })
    expect(parseSend({ chat_id: -1001, reply_to: '7', files: ['/tmp/a.png'], format: 'markdownv2' })).toEqual({
      chatId: '-1001', topic: 'general', text: '', replyTo: 7, files: ['/tmp/a.png'], markdown: true,
    })
  })

  test('message ids must be integers rather than becoming NaN', () => {
    rejects(() => parseReact({ chat_id: '-1', message_id: 'abc', emoji: '👍' }), 'message_id')
    rejects(() => parseEdit({ chat_id: '-1', text: 'x' }), 'message_id')
    rejects(() => parseSend({ chat_id: '-1', reply_to: '1.5' }), 'reply_to')
    expect(parseReact({ chat_id: '-1', message_id: '12', emoji: '👍' }).messageId).toBe(12)
  })

  test('a topic is "general" or a thread id, so no phantom topic is created', () => {
    rejects(() => parseRateLimit({ topic: 'claude-hostthis-34' }), 'topic')
    rejects(() => parseTurnFailed({}), 'topic')
    rejects(() => parseSend({ chat_id: '-1', topic: '../x' }), 'topic')
    expect(parseRateLimit({ topic: 'general' }).topic).toBe('general')
  })

  test('files must be paths', () => {
    rejects(() => parseSend({ chat_id: '-1', files: [{ path: '/x' }] }), 'files')
    rejects(() => parseSend({ chat_id: '-1', files: '/x' }), 'files')
  })

  test('a body that is not an object is refused', () => {
    for (const body of [null, [], 'text', 3]) rejects(() => parseSend(body), 'JSON object')
  })

  test('fields with a defined fallback tolerate garbage', () => {
    expect(parseRateLimit({ topic: '42', reset_at: 'soon' })).toEqual({ topic: '42' })
    expect(parseRateLimit({ topic: '42', reset_at: 1_800_000_000 }).resetAt).toBe(1_800_000_000)
    expect(parseRateLimit({ topic: '42', provider: 'anthropic', model: 'fable' }).ranOn).toEqual({ provider: 'anthropic', model: 'fable' })
    expect(parseRateLimit({ topic: '42', provider: '', model: '' }).ranOn).toBeUndefined()
    expect(parseSquareReply({ topic: '42', conv: '9', text: ' hi ', reply_token: 'x' }))
      .toEqual({ caller: '42', conv: '9', text: 'hi' })
    expect(parseSquareReply({ topic: 'operator', conv: '9', text: 'hi', reply_token: '15' }).replyToken).toBe(15)
  })

  test('topic creation names a known harness', () => {
    expect(parseTopicCreate({ name: ' Pilot ' })).toEqual({ name: 'Pilot', harness: 'claude' })
    rejects(() => parseTopicCreate({ name: 'x', harness: 'gemini' }), 'harness')
    rejects(() => parseTopicCreate({ name: '  ' }), 'name')
  })

  test('a permission request needs its request id', () => {
    rejects(() => parsePermissionRequest({ topic: '42' }), 'request_id')
    expect(parsePermissionRequest({ request_id: 'r1' }))
      .toEqual({ topic: 'general', requestId: 'r1', tool: 'tool', input: '' })
  })

  test('cancelling a reminder needs its topic and id', () => {
    rejects(() => parseCancelReminder({ topic: '42' }), 'id')
    expect(parseCancelReminder({ topic: '42', id: 'ab12' })).toEqual({ topic: '42', id: 'ab12' })
  })

  test('a failed-turn error label is capped', () => {
    expect(parseTurnFailed({ topic: '42', error: 'x'.repeat(100) }).error).toHaveLength(40)
  })
})
