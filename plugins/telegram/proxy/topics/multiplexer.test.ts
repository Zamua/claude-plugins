import { describe, expect, test } from 'bun:test'
import { claudePromptVisible, parseHerdrProcessInfo } from './multiplexer'

describe('Claude foreground prompt detection', () => {
  test('reads a blank foreground prompt as ready while background work continues', () => {
    expect(claudePromptVisible(`
  Waiting for 2 background agents to finish

---------------------------------------------- ultracode -
❯
----------------------------------------------------------
  Claude · codex · gpt-5.6-sol[1m] · xhigh

  ⏺ main
  ◯ verifier                                      12m
`)).toBeTrue()
  })

  test('keeps the foreground prompt ready after Claude displays a queued-message hint', () => {
    expect(claudePromptVisible(`
  Updating runbooks…n…
  ← telegram · user: first queued turn

❯ Press up to edit queued messages
----------------------------------------------------------
  Claude · codex · gpt-5.6-sol[1m] · medium
`)).toBeTrue()
  })

  test('does not mistake active output or a partially typed prompt for readiness', () => {
    expect(claudePromptVisible('Thinking…\n  esc to interrupt')).toBeFalse()
    expect(claudePromptVisible('❯ partially typed text\n---\n  Claude · codex')).toBeFalse()
  })
})

test('herdr\'s process info gives the pane\'s foreground group, and nothing for an answer it cannot read', () => {
  const answer = JSON.stringify({ id: 'cli:pane:process_info', result: { process_info: { foreground_process_group_id: 25267, foreground_processes: [{ name: 'claude' }] } } })
  expect(parseHerdrProcessInfo(answer)?.foreground_process_group_id).toBe(25267)
  expect(parseHerdrProcessInfo('not json')).toBeUndefined()
  expect(parseHerdrProcessInfo('{"result":{}}')).toBeUndefined()
})
