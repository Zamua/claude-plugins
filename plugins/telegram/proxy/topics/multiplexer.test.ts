import { describe, expect, test } from 'bun:test'
import { claudePromptVisible } from './multiplexer'

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
