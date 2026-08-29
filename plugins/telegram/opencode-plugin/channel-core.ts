// Pure helpers stay outside the plugin module because opencode treats named
// exports in a plugin module as additional plugin entry points.

export function renderChannel(content: string, meta: Record<string, string>): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ')}"`)
    .join('')
  return `<channel source="plugin:telegram:telegram"${attrs}>\n${content}\n</channel>`
}

export function isIdleEvent(event: any, sessionId: string): boolean {
  if (event?.type === 'session.idle') {
    return event.properties?.sessionID === sessionId
  }
  return (
    event?.type === 'session.status' &&
    event.properties?.sessionID === sessionId &&
    event.properties?.status?.type === 'idle'
  )
}

export function textFromParts(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('\n')
    .trim()
}
