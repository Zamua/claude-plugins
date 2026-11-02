// GitHub-flavored Markdown as Telegram MarkdownV2. What Telegram cannot draw
// becomes the nearest thing it can: a heading a bold line, a list item a "• "
// or "1. " line, a table a monospace block, a rule a line of box characters.
// Every character outside markup is escaped, so a conversion never fails to parse.
import { Lexer } from 'marked'
import type { Token, Tokens } from 'marked'

/** One top-level block: its MarkdownV2 and the Markdown it came from, sent as plain text if Telegram refuses it. */
export type V2Block = { v2: string; source: string }

const escape = (text: string) => text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
const escapeCode = (text: string) => text.replace(/[`\\]/g, '\\$&')
const escapeUrl = (url: string) => url.replace(/[)\\]/g, '\\$&')
const linkable = (href: string) => /^(https?:|tg:|mailto:)/i.test(href)
const INDENT = '    '
const RULE = '──────────'

/** Inline tokens with their markup dropped, for a table cell's width. */
function plain(tokens: readonly Token[] | undefined): string {
  return (tokens ?? [])
    .map(t => {
      if ('tokens' in t && t.tokens?.length) return plain(t.tokens)
      if (t.type === 'br') return ' '
      return 'text' in t ? String(t.text) : t.raw
    })
    .join('')
}

/** The styles already open around a run: Telegram has no nested bold, and `__` would read as underline. */
type Open = { bold?: boolean; italic?: boolean; strike?: boolean }

function inline(tokens: readonly Token[] | undefined, open: Open = {}): string {
  return (tokens ?? []).map(t => inlineToken(t, open)).join('')
}

const styled = (marker: string, active: boolean | undefined, body: string) => (active ? body : `${marker}${body}${marker}`)

function inlineToken(t: Token, open: Open): string {
  switch (t.type) {
    case 'strong':
      return styled('*', open.bold, inline(t.tokens, { ...open, bold: true }))
    case 'em':
      return styled('_', open.italic, inline(t.tokens, { ...open, italic: true }))
    case 'del':
      return styled('~', open.strike, inline(t.tokens, { ...open, strike: true }))
    case 'codespan':
      return `\`${escapeCode(t.text)}\``
    case 'br':
      return '\n'
    case 'link':
    case 'image': {
      const label = t.type === 'image' ? escape(t.text || t.href) : inline(t.tokens, open) || escape(t.href)
      return linkable(t.href) ? `[${label}](${escapeUrl(t.href)})` : `${label} \\(${escape(t.href)}\\)`
    }
    case 'text':
      return 'tokens' in t && t.tokens?.length ? inline(t.tokens, open) : escape(t.text)
    case 'escape':
      return escape(t.text)
    default:
      return escape(t.raw)
  }
}

function table(t: Tokens.Table): string {
  const rows = [t.header.map(c => plain(c.tokens)), ...t.rows.map(r => r.map(c => plain(c.tokens)))]
  const widths = t.header.map((_, i) => Math.max(...rows.map(r => [...(r[i] ?? '')].length)))
  const pad = (cell: string, i: number) => {
    const gap = ' '.repeat(widths[i] - [...cell].length)
    return t.align[i] === 'right' ? gap + cell : cell + gap
  }
  const line = (r: string[]) => r.map((c, i) => pad(c ?? '', i)).join(' │ ').trimEnd()
  const lines = [line(rows[0]), widths.map(w => '─'.repeat(w)).join('─┼─'), ...rows.slice(1).map(line)]
  return `\`\`\`\n${escapeCode(lines.join('\n'))}\n\`\`\``
}

function list(t: Tokens.List, depth: number): string {
  const start = typeof t.start === 'number' ? t.start : 1
  return t.items
    .map((item, i) => {
      const marker = item.task ? (item.checked ? '☑' : '☐') : t.ordered ? `${start + i}\\.` : '•'
      const [first, ...rest] = blocks(item.tokens.filter(x => x.type !== 'checkbox'), depth + 1)
      const lead = `${INDENT.repeat(depth)}${marker} ${first ?? ''}`.trimEnd()
      const more = rest.map(b => (b.startsWith(INDENT.repeat(depth + 1)) ? b : indent(b, depth + 1)))
      return [lead, ...more].join('\n')
    })
    .join('\n')
}

const indent = (text: string, depth: number) =>
  text.split('\n').map(l => (l ? INDENT.repeat(depth) + l : l)).join('\n')

function block(t: Token, depth: number): string | undefined {
  switch (t.type) {
    case 'heading':
      return `*${inline(t.tokens, { bold: true })}*`
    case 'paragraph':
      return inline(t.tokens)
    case 'text':
      return 'tokens' in t && t.tokens?.length ? inline(t.tokens) : escape(t.text)
    case 'list':
      return list(t as Tokens.List, depth)
    case 'code':
      return `\`\`\`${/^[\w+-]+$/.test(t.lang ?? '') ? t.lang : ''}\n${escapeCode(t.text)}\n\`\`\``
    case 'blockquote':
      return blocks(t.tokens ?? [], 0)
        .join('\n')
        .split('\n')
        .map(l => `>${l}`)
        .join('\n')
    case 'table':
      return table(t as Tokens.Table)
    case 'hr':
      return RULE
    case 'space':
    case 'def':
      return undefined
    default:
      return escape(t.raw.trimEnd())
  }
}

function blocks(tokens: readonly Token[], depth: number): string[] {
  return tokens.map(t => block(t, depth)).filter((b): b is string => b !== undefined && b !== '')
}

/** The message as MarkdownV2 blocks, each with its own source; throws only on input the lexer cannot read. */
export function markdownV2Blocks(markdown: string): V2Block[] {
  return Lexer.lex(markdown, { gfm: true })
    .map(t => ({ v2: block(t, 0), source: t.raw.trim() }))
    .filter((b): b is V2Block => b.v2 !== undefined && b.v2 !== '')
}

/** The whole message as MarkdownV2. */
export const markdownV2 = (markdown: string): string => markdownV2Blocks(markdown).map(b => b.v2).join('\n\n')

/**
 * Blocks packed into messages of at most `limit` characters. A block too long
 * for one message goes as its source, split by lines, with no MarkdownV2.
 */
export function messageParts(blocks: readonly V2Block[], limit: number): Array<{ v2?: string; source: string }> {
  const parts: Array<{ v2?: string; source: string }> = []
  let v2 = ''
  let source = ''
  const flush = () => {
    if (v2) parts.push({ v2, source })
    v2 = ''
    source = ''
  }
  for (const b of blocks) {
    if (b.v2.length > limit) {
      flush()
      for (const piece of splitLines(b.source, limit)) parts.push({ source: piece })
      continue
    }
    if (v2 && v2.length + 2 + b.v2.length > limit) flush()
    v2 = v2 ? `${v2}\n\n${b.v2}` : b.v2
    source = source ? `${source}\n\n${b.source}` : b.source
  }
  flush()
  return parts
}

function splitLines(text: string, limit: number): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const line of text.split('\n')) {
    for (let at = 0; at < Math.max(line.length, 1); at += limit) {
      const bit = line.slice(at, at + limit)
      if (piece && piece.length + 1 + bit.length > limit) {
        pieces.push(piece)
        piece = ''
      }
      piece = piece ? `${piece}\n${bit}` : bit
    }
  }
  if (piece) pieces.push(piece)
  return pieces
}
