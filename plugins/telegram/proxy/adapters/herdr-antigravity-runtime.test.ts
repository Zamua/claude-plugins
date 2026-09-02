import { describe, expect, test } from 'bun:test'
import {
  antigravityHerdrStatus,
  antigravityInteractiveArgs,
  findAntigravityPane,
  HerdrAntigravityRuntime,
  parseAntigravityConversationId,
  parseHerdrPromptResult,
} from './herdr-antigravity-runtime'
import type { ProcessRunner } from './process-runner'

describe('persistent Herdr Antigravity adapter', () => {
  test('starts a fresh interactive conversation with a kickoff', () => {
    expect(antigravityInteractiveArgs({
      modelVariant: 'gemini-3.8-flash-medium',
      effort: 'medium',
      kickoff: 'setup; do not shell-parse this',
    })).toEqual([
      '--model', 'gemini-3.8-flash-medium',
      '--effort', 'medium',
      '--dangerously-skip-permissions',
      '--prompt-interactive', 'setup; do not shell-parse this',
    ])
  })

  test('resumes the exact conversation without replaying kickoff', () => {
    expect(antigravityInteractiveArgs({
      modelVariant: 'claude-opus-4-6-thinking',
      effort: 'high',
      conversationId: 'conv-1',
      kickoff: 'must not be sent again',
    })).toEqual([
      '--model', 'claude-opus-4-6-thinking',
      '--effort', 'high',
      '--dangerously-skip-permissions',
      '--conversation', 'conv-1',
    ])
  })

  test('finds a pane by its stable label and maps Herdr lifecycle state', () => {
    const output = JSON.stringify({ result: { panes: [
      { label: 'other', pane_id: 'w1:p1', agent_status: 'idle' },
      { label: 'agy-pilot-42', pane_id: 'w2:p1', agent_status: 'working' },
    ] } })
    const pane = findAntigravityPane(output, 'agy-pilot-42')
    expect(pane).toEqual({ paneId: 'w2:p1', status: 'working' })
    expect(antigravityHerdrStatus(pane, true)).toBe('busy')
    expect(antigravityHerdrStatus({ paneId: 'w2:p1', status: 'unknown' }, true)).toBe('starting')
    expect(antigravityHerdrStatus({ paneId: 'w2:p1', status: 'unknown' }, false)).toBe('missing')
  })

  test('reads the conversation identity from the agy process open files', () => {
    expect(parseAntigravityConversationId([
      'p41636',
      'n/Users/me/.gemini/antigravity-cli/conversation_summaries.db',
      'n/Users/me/.gemini/antigravity-cli/conversations/6cd329b3-5f61-494c-b283-8a40400e2e32.db',
      'n/Users/me/.gemini/antigravity-cli/conversations/6cd329b3-5f61-494c-b283-8a40400e2e32.db-wal',
    ].join('\n'))).toBe('6cd329b3-5f61-494c-b283-8a40400e2e32')
  })

  test('distinguishes an accepted prompt from Herdr\'s zero-exit stalled result', () => {
    expect(parseHerdrPromptResult(JSON.stringify({ result: { type: 'agent_prompted' } })))
      .toBe('agent_prompted')
    expect(parseHerdrPromptResult(JSON.stringify({ result: { type: 'agent_prompt_stalled' } })))
      .toBe('agent_prompt_stalled')
    expect(parseHerdrPromptResult('not json')).toBeUndefined()
  })

  test('retries a structured prompt stall instead of silently dropping the turn', async () => {
    let promptCalls = 0
    const run: ProcessRunner = async (_command, args) => {
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({ result: { panes: [{
            label: 'agy-topic-42', pane_id: 'w2:p1', agent_status: 'idle',
          }] } }),
          stderr: '',
        }
      }
      if (args[0] === 'agent' && args[1] === 'prompt') {
        promptCalls++
        return {
          stdout: JSON.stringify({ result: {
            type: promptCalls === 1 ? 'agent_prompt_stalled' : 'agent_prompted',
          } }),
          stderr: '',
        }
      }
      throw new Error(`unexpected args: ${args.join(' ')}`)
    }
    const runtime = new HerdrAntigravityRuntime(
      'agy', '/tmp/project', '/tmp/launcher', 'http://127.0.0.1:8790', 'herdr', run,
      async () => {},
    )

    await runtime.prompt('agy-topic-42', 'telegram turn')
    expect(promptCalls).toBe(2)
  })

  test('closes a same-labelled pane when it belongs to the wrong conversation', async () => {
    const closed: string[] = []
    const run: ProcessRunner = async (command, args) => {
      if (command === '/usr/sbin/lsof') {
        return {
          stdout: 'n/Users/me/.gemini/antigravity-cli/conversations/11111111-1111-1111-1111-111111111111.db\n',
          stderr: '',
        }
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({ result: { panes: [{
            label: 'agy-topic-42', pane_id: 'w2:p1', agent_status: 'idle',
          }] } }),
          stderr: '',
        }
      }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return {
          stdout: JSON.stringify({ result: { process_info: {
            foreground_processes: [{ name: 'agy', pid: 123 }],
          } } }),
          stderr: '',
        }
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        closed.push(args[2]!)
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }
    const runtime = new HerdrAntigravityRuntime(
      'agy', '/tmp/project', '/tmp/launcher', 'http://127.0.0.1:8790', 'herdr', run,
    )

    await expect(runtime.ensureSession({
      topic: '42',
      name: 'topic',
      sessionName: 'agy-topic-42',
      route: { modelVariant: 'gemini-3.8-flash-high', effort: 'high' },
      conversationId: '22222222-2222-2222-2222-222222222222',
      kickoff: 'unused',
    })).rejects.toThrow('opened 11111111-1111-1111-1111-111111111111')
    expect(closed).toEqual(['w2:p1'])
  })
})
