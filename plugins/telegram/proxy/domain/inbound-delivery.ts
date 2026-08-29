import type { TopicRoute } from './model-routing'

export type InboundMode = 'channel' | 'pane'

export type InboundMessage = {
  content: string
  meta: Record<string, string>
}

export function inboundModeForRoute(route: TopicRoute): InboundMode {
  return route.provider === 'anthropic' ? 'channel' : 'pane'
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Render the user turn Claude Code normally constructs from a Channel
 * notification. Custom provider sessions reject Channel notifications, so the
 * pane adapter submits this equivalent envelope through Claude's foreground
 * prompt while keeping the same Claude session and MCP tools.
 */
export function renderPaneTurn(message: InboundMessage): string {
  const attributes = Object.entries(message.meta)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(' ')
  const opening = `<channel source="plugin:telegram:telegram"${attributes ? ` ${attributes}` : ''}>`
  return [
    opening,
    message.content,
    '</channel>',
    '',
    'This is an inbound Telegram turn. Respond through the telegram MCP reply tool; transcript output is not visible to the sender.',
  ].join('\n')
}
