import { describe, expect, test } from 'bun:test'
import {
  applyOpencodePending,
  opencodeSessionName,
  opencodeTopic,
  opencodeTopicFromRecord,
  renderOpencodeKickoff,
  renderOpencodeTurn,
  requestOpencodeRestart,
  withOpencodeSession,
} from './opencode-topic'

describe('OpenCode topic', () => {
  test('marks the aggregate as harness-locked with no route', () => {
    const topic = opencodeTopic('42', 'localcode pilot', 10)
    expect(topic.harness).toBe('opencode')
    expect(topic.name).toBe('localcode pilot')
    expect(topic.opencodeSessionId).toBeUndefined()
    expect(topic.sessionName).toBeUndefined()
    expect('route' in topic).toBeFalse()
  })

  test('falls back to the topic id as name and rejects an empty topic id', () => {
    expect(opencodeTopic('42', '   ', 10).name).toBe('42')
    expect(() => opencodeTopic('  ', 'x')).toThrow('OpenCode topic id is required')
  })

  test('uses a readable, stable Herdr session name', () => {
    expect(opencodeSessionName('42', 'Localcode Pilot!')).toBe('oc-localcode-pilot-42')
    expect(opencodeSessionName('42', '!!!')).toBe('oc-topic-42')
    expect(opencodeSessionName('7', 'a'.repeat(40))).toBe(`oc-${'a'.repeat(24)}-7`)
  })

  test('persists pane identity with the exact OpenCode session id', () => {
    const topic = opencodeTopic('42', 'pilot', 10)
    const running = withOpencodeSession(topic, 'oc-pilot-42', 'ses_1', 20)
    expect(running.sessionName).toBe('oc-pilot-42')
    expect(running.opencodeSessionId).toBe('ses_1')
    expect(running.updatedAt).toBe(20)
    expect(() => withOpencodeSession(topic, ' ', 'ses_1')).toThrow('session name is required')
    expect(() => withOpencodeSession(topic, 'oc-pilot-42', ' ')).toThrow('session id is required')
  })

  test('queues a restart until the current turn is safe to stop', () => {
    const topic = opencodeTopic('42', 'pilot', 10)
    const requested = requestOpencodeRestart(topic, 20)
    expect(requested.restartPending).toBeTrue()
    const applied = applyOpencodePending(requested, 30)
    expect(applied.restartPending).toBeUndefined()
    expect(applied.updatedAt).toBe(30)
  })

  test('accepts only well-formed persisted records', () => {
    const valid = withOpencodeSession(opencodeTopic('42', 'pilot', 10), 'oc-pilot-42', 'ses_1', 20)
    expect(opencodeTopicFromRecord(valid)).toEqual(valid)
    expect(opencodeTopicFromRecord({ ...valid, restartPending: true })?.restartPending).toBeTrue()
    expect(opencodeTopicFromRecord(undefined)).toBeUndefined()
    expect(opencodeTopicFromRecord({ ...valid, harness: 'antigravity' })).toBeUndefined()
    expect(opencodeTopicFromRecord({ ...valid, topic: 42 })).toBeUndefined()
    expect(opencodeTopicFromRecord({ ...valid, createdAt: 'x' })).toBeUndefined()
    expect(opencodeTopicFromRecord({ ...valid, sessionName: 1 })).toBeUndefined()
    expect(opencodeTopicFromRecord({ ...valid, opencodeSessionId: 1 })).toBeUndefined()
    expect(opencodeTopicFromRecord({ ...valid, restartPending: 'yes' })).toBeUndefined()
  })

  test('kickoff names the local model, native instructions, and outbound MCP delivery', () => {
    const kickoff = renderOpencodeKickoff()
    expect(kickoff).toContain('local Qwen model')
    expect(kickoff).toContain('persistent Herdr workspace')
    expect(kickoff).toContain('telegram-topics_reply')
    expect(kickoff).toContain('AGENTS.md')
    expect(kickoff).toContain('~/.claude/CLAUDE.md')
    expect(kickoff).toContain('image_path')
    expect(kickoff).toContain('attachment_path')
    expect(kickoff).toContain('concise')
    expect(kickoff.endsWith(
      'Acknowledge this setup in the terminal only, then wait for the first Telegram or terminal prompt.',
    )).toBeTrue()
  })

  test('turn wraps the message in the channel envelope with escaped meta', () => {
    const turn = renderOpencodeTurn({
      content: 'check the GPU project',
      meta: { chat_id: '-1001', user: 'a"b<c>&d', message_thread_id: '42' },
    })
    expect(turn).toContain('<channel source="telegram" chat_id="-1001" user="a&quot;b&lt;c&gt;&amp;d" message_thread_id="42">')
    expect(turn).toContain('check the GPU project\n</channel>')
    expect(turn).toContain('telegram-topics_reply')
    expect(turn).toContain('chat_id above')
  })
})
