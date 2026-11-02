import { describe, expect, test } from 'bun:test'
import { spinnerActivity, toolLabel, transcriptActivity } from './activity'

const NOW = Date.parse('2026-11-02T03:00:00.000Z')
const line = (o: object) => JSON.stringify(o)
const toolUse = (id: string, name: string, input: object, timestamp = '2026-11-02T02:59:50.000Z') =>
  line({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const prompt = (text: string) => line({ type: 'user', message: { content: text } })

describe('toolLabel', () => {
  test('names the tool and a short target', () => {
    expect(toolLabel('Bash', { command: 'npm test\nnpm run lint', description: 'Run tests' })).toBe('Bash: npm test')
    expect(toolLabel('Bash', { command: 'cd ~/proj && bun test --watch' })).toBe('Bash: bun test --watch')
    expect(toolLabel('Read', { file_path: '/home/op/proj/src/app.ts' })).toBe('Read: src/app.ts')
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('Grep: TODO')
    expect(toolLabel('WebFetch', { url: 'https://example.com/a/b?c=1' })).toBe('WebFetch: example.com')
    expect(toolLabel('Agent', { description: 'Review the diff', prompt: 'long' })).toBe('Agent: Review the diff')
    expect(toolLabel('mcp__plugin_telegram_telegram__reply', { text: 'hi' })).toBe('reply')
    expect(toolLabel('TodoWrite', { todos: [] })).toBe('TodoWrite')
  })

  test('a long target is clipped with an ellipsis', () => {
    const label = toolLabel('Bash', { command: `echo ${'x'.repeat(200)}` })
    expect(label.length).toBe(66)
    expect(label.endsWith('…')).toBeTrue()
  })
})

describe('transcriptActivity', () => {
  test('the last tool_use with no tool_result, since its own timestamp', () => {
    const lines = [prompt('run the tests'), toolUse('a', 'Read', { file_path: '/p/src/x.ts' }), toolResult('a'), toolUse('b', 'Bash', { command: 'bun test' }, '2026-11-02T02:59:55.000Z')]
    expect(transcriptActivity(lines, NOW)).toEqual({ label: 'Bash: bun test', since: '2026-11-02T02:59:55.000Z' })
  })

  test('nothing in flight once every tool has its result, and a new prompt forgets an earlier turn', () => {
    expect(transcriptActivity([toolUse('a', 'Bash', { command: 'ls' }), toolResult('a')], NOW)).toBeUndefined()
    expect(transcriptActivity([toolUse('a', 'Bash', { command: 'ls' }), prompt('next')], NOW)).toBeUndefined()
  })

  test('a partial first line, a sidechain and a meta message are ignored', () => {
    const lines = [
      '{"type":"assist',
      toolUse('a', 'Edit', { file_path: '/p/a.ts' }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 's', name: 'Grep', input: {} }] } }),
      line({ type: 'user', isMeta: true, message: { content: 'reminder' } }),
    ]
    expect(transcriptActivity(lines, NOW)?.label).toBe('Edit: p/a.ts')
  })
})

describe('spinnerActivity', () => {
  test('the verb, the turn start from its elapsed time, and its tokens', () => {
    const screen = '⏺ Done.\n✢ Frolicking… (1m 25s · ↓ 7.4k tokens)\n  ⎿  Tip: something\n❯ \n'
    expect(spinnerActivity(screen, NOW)).toEqual({ label: 'Frolicking…', since: '2026-11-02T02:58:35.000Z', tokens: 7400 })
  })

  test('a spinner without details starts now; a screen without one has no activity', () => {
    expect(spinnerActivity('✻ Thinking…\n', NOW)).toEqual({ label: 'Thinking…', since: '2026-11-02T03:00:00.000Z' })
    expect(spinnerActivity('⏺ Bash(ls)\n❯ \n  Claude · anthropic · opus\n', NOW)).toBeUndefined()
  })
})
