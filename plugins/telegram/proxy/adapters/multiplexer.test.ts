import { describe, expect, test } from 'bun:test'
import { claudePromptVisible, herdrRuntime } from './multiplexer'

describe('multiplexer adapter status mapping', () => {
  test('treats idle and completed Claude panes as promptable', () => {
    expect(herdrRuntime('idle', true)).toBe('idle')
    expect(herdrRuntime('done', true)).toBe('idle')
  })

  test('does not inject into working or blocked panes', () => {
    expect(herdrRuntime('working', true)).toBe('busy')
    expect(herdrRuntime('blocked', true)).toBe('blocked')
  })

  test('treats a blank foreground prompt as ready while background work continues', () => {
    expect(herdrRuntime('working', true, true)).toBe('idle')
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

  test('does not mistake active output or a partially typed prompt for readiness', () => {
    expect(claudePromptVisible('Thinking…\n  esc to interrupt')).toBeFalse()
    expect(claudePromptVisible('❯ partially typed text\n---\n  Claude · codex')).toBeFalse()
  })

  test('distinguishes a starting agent from a restored dead shell', () => {
    expect(herdrRuntime('unknown', true)).toBe('starting')
    expect(herdrRuntime('unknown', false)).toBe('missing')
  })
})
