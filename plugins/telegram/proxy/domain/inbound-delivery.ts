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

/** A <channel> element carrying the message, its meta as attributes in insertion order. */
export function channelEnvelope(source: string, message: InboundMessage): string {
  const attributes = Object.entries(message.meta)
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join('')
  return `<channel source="${source}"${attributes}>\n${message.content}\n</channel>`
}

/**
 * Render the user turn Claude Code normally constructs from a Channel
 * notification. Custom provider sessions reject Channel notifications, so the
 * pane adapter submits this equivalent envelope through Claude's foreground
 * prompt while keeping the same Claude session and MCP tools.
 */
export function renderPaneTurn(message: InboundMessage): string {
  const sorted = Object.entries(message.meta).sort(([left], [right]) => left.localeCompare(right))
  return [
    channelEnvelope('plugin:telegram:telegram', { ...message, meta: Object.fromEntries(sorted) }),
    '',
    'This is an inbound Telegram turn. Respond through the telegram MCP reply tool; transcript output is not visible to the sender.',
  ].join('\n')
}
