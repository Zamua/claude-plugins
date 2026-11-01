import { describe, expect, test } from 'bun:test'
import { findHerdrPane, herdrAgentStatus, parseHerdrPanes } from './herdr-panes'

const output = JSON.stringify({ result: { panes: [
  { label: 'other', pane_id: 'w1:p1', agent_status: 'idle' },
  { label: 'oc-pilot-42', pane_id: 'w2:p1', agent_status: 'working' },
  { label: 'restored', pane_id: 'w3:p1' },
  { pane_id: 'w4:p1', agent_status: 'idle' },
] } })

describe('Herdr pane list', () => {
  test('keys labeled panes by label and treats a missing status as unknown', () => {
    const panes = parseHerdrPanes(output)
    expect([...panes.keys()]).toEqual(['other', 'oc-pilot-42', 'restored'])
    expect(panes.get('restored')).toEqual({ paneId: 'w3:p1', status: 'unknown' })
  })

  test('reads malformed output as no panes', () => {
    expect(parseHerdrPanes('not json').size).toBe(0)
    expect(parseHerdrPanes('{}').size).toBe(0)
  })

  test('finds a pane by its stable label', () => {
    expect(findHerdrPane(output, 'oc-pilot-42')).toEqual({ paneId: 'w2:p1', status: 'working' })
    expect(findHerdrPane(output, 'absent')).toBeUndefined()
  })

  test('idle and completed panes are promptable', () => {
    expect(herdrAgentStatus('idle', true)).toBe('idle')
    expect(herdrAgentStatus('done', false)).toBe('idle')
  })

  test('working and blocked panes are not', () => {
    expect(herdrAgentStatus('working', true)).toBe('busy')
    expect(herdrAgentStatus('blocked', true)).toBe('blocked')
  })

  test('a blank foreground prompt is ready while background work continues', () => {
    expect(herdrAgentStatus('working', true, true)).toBe('idle')
  })

  test('the foreground process tells a starting agent from a restored dead shell', () => {
    expect(herdrAgentStatus('unknown', true)).toBe('starting')
    expect(herdrAgentStatus('unknown', false)).toBe('missing')
  })
})
