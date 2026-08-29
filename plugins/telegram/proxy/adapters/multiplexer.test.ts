import { describe, expect, test } from 'bun:test'
import { herdrRuntime } from './multiplexer'

describe('multiplexer adapter status mapping', () => {
  test('treats idle and completed Claude panes as promptable', () => {
    expect(herdrRuntime('idle', true)).toBe('idle')
    expect(herdrRuntime('done', true)).toBe('idle')
  })

  test('does not inject into working or blocked panes', () => {
    expect(herdrRuntime('working', true)).toBe('busy')
    expect(herdrRuntime('blocked', true)).toBe('blocked')
  })

  test('distinguishes a starting agent from a restored dead shell', () => {
    expect(herdrRuntime('unknown', true)).toBe('starting')
    expect(herdrRuntime('unknown', false)).toBe('missing')
  })
})
