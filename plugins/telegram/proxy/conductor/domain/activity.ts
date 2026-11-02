// What a working agent is doing right now, for the app's working strip: the
// tool in flight from its transcript, else the spinner Claude Code draws.

export type Activity = {
  label: string
  /** ISO time the tool started, or the turn did for a spinner. */
  since: string
  /** Tokens the spinner reports for the turn so far. */
  tokens?: number
}

const MAX_LABEL = 80
const MAX_TARGET = 60

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const str = (input: Record<string, unknown>, key: string): string | undefined =>
  typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string) : undefined

const lastSegments = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/')

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function target(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'Bash':
      // A leading `cd <dir> &&` says where, not what.
      return str(input, 'command')?.split('\n')[0].replace(/^\s*cd\s+\S+\s*&&\s*/, '')
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit': {
      const path = str(input, 'file_path')
      return path && lastSegments(path)
    }
    case 'NotebookEdit': {
      const path = str(input, 'notebook_path')
      return path && lastSegments(path)
    }
    case 'Grep':
    case 'Glob':
      return str(input, 'pattern')
    case 'WebFetch': {
      const url = str(input, 'url')
      return url && host(url)
    }
    case 'WebSearch':
    case 'ToolSearch':
      return str(input, 'query')
    case 'Skill':
      return str(input, 'skill')
    default:
      return str(input, 'description')
  }
}

/** "Bash: npm test", "Read: src/app.ts"; an MCP tool by its own name. */
export function toolLabel(name: string, input: unknown): string {
  const shown = name.startsWith('mcp__') ? name.split('__').at(-1) || name : name
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const goal = target(name, args)
  return clip(goal ? `${shown}: ${clip(goal, MAX_TARGET)}` : shown, MAX_LABEL)
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }

/**
 * The tool a transcript says is running: the last tool_use, after the last
 * prompt, that has no tool_result yet. `lines` may start mid-line (a tail);
 * what does not parse is skipped.
 */
export function transcriptActivity(lines: readonly string[], now: number): Activity | undefined {
  const pending = new Map<string, Activity>()
  for (const line of lines) {
    let entry: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; timestamp?: unknown; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain === true) continue
    const content = entry.message?.content
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
        const at = typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)) ? entry.timestamp : new Date(now).toISOString()
        pending.set(block.id, { label: toolLabel(block.name, block.input), since: at })
      }
    } else if (entry.type === 'user' && entry.isMeta !== true) {
      const blocks = Array.isArray(content) ? (content as Block[]) : []
      const results = blocks.filter(b => b.type === 'tool_result')
      for (const r of results) if (typeof r.tool_use_id === 'string') pending.delete(r.tool_use_id)
      if (!results.length && (typeof content === 'string' || blocks.some(b => b.type === 'text'))) pending.clear()
    }
  }
  return [...pending.values()].at(-1)
}

const SPINNER = /^\s*[·✢✳✶✻✽*]\s+([^\s()][^()]*?…)\s*(?:\(([^)]*)\))?\s*$/

function elapsedMs(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+)\s*([hms])\b/g)]
  if (!parts.length) return undefined
  const unit = { h: 3_600_000, m: 60_000, s: 1_000 } as const
  return parts.reduce((sum, [, n, u]) => sum + Number(n) * unit[u as keyof typeof unit], 0)
}

function tokenCount(text: string): number | undefined {
  const m = /[↑↓]\s*([\d.]+)\s*([km])?\s*tokens/i.exec(text)
  if (!m) return undefined
  const scale = m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1_000 : 1
  const value = Math.round(Number(m[1]) * scale)
  return Number.isFinite(value) ? value : undefined
}

/** Claude Code's spinner on a screen, e.g. "✢ Frolicking… (1m 25s · ↓ 7.4k tokens)"; the lowest one wins. */
export function spinnerActivity(screen: string, now: number): Activity | undefined {
  for (const line of screen.split('\n').reverse()) {
    const m = SPINNER.exec(line)
    if (!m) continue
    const detail = m[2] ?? ''
    const took = elapsedMs(detail.split('·')[0] ?? '')
    const tokens = tokenCount(detail)
    return {
      label: clip(m[1], MAX_LABEL),
      since: new Date(now - (took ?? 0)).toISOString(),
      ...(tokens !== undefined ? { tokens } : {}),
    }
  }
  return undefined
}
