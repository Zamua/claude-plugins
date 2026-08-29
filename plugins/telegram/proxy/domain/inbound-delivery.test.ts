import { describe, expect, test } from 'bun:test'
import { inboundModeForRoute, renderPaneTurn } from './inbound-delivery'

describe('provider-aware inbound delivery', () => {
  test('uses native Claude Channels only for Anthropic', () => {
    expect(inboundModeForRoute({ provider: 'anthropic', model: 'fable', effort: 'xhigh' })).toBe('channel')
    expect(inboundModeForRoute({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' })).toBe('pane')
    expect(inboundModeForRoute({ provider: 'opencode-go', model: 'opencode-go/glm-5.2', effort: 'high' })).toBe('pane')
  })

  test('renders the Telegram metadata and reply contract as one Claude prompt', () => {
    const turn = renderPaneTurn({
      content: 'please continue',
      meta: { user: 'zamua', chat_id: '-100123', note: 'one & "two"' },
    })
    expect(turn).toContain('<channel source="plugin:telegram:telegram" chat_id="-100123" note="one &amp; &quot;two&quot;" user="zamua">')
    expect(turn).toContain('\nplease continue\n</channel>')
    expect(turn).toContain('telegram MCP reply tool')
  })
})
