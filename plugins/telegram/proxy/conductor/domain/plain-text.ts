// A message as plain text, for the places that cannot render its markup: a
// push notification and a topic's preview line. Link text is kept, the URL
// dropped; code keeps its content without the backticks.
import type { MessageFormat } from './message'

/** Telegram MarkdownV2: a backslash escapes the next character; * _ ~ | ` and the link brackets are markup. */
function fromMarkdownV2(text: string): string {
  let out = ''
  let i = 0
  let inCode = false
  while (i < text.length) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) {
      out += text[i + 1]
      i += 2
      continue
    }
    if (text.startsWith('```', i)) {
      // A fence opens with an optional language word on its own line.
      i += 3
      if (!inCode) while (i < text.length && /[A-Za-z0-9_+-]/.test(text[i])) i++
      // The fence's own line goes with it: the newline after an opening fence, or after a closing one that ends a line.
      if (text[i] === '\n' && (!inCode || out.endsWith('\n'))) i++
      inCode = !inCode
      continue
    }
    if (inCode) {
      out += c
      i++
      continue
    }
    if (c === '[') {
      const close = closingBracket(text, i)
      if (close > 0 && text[close + 1] === '(') {
        const end = closingParen(text, close + 1)
        if (end > 0) {
          out += fromMarkdownV2(text.slice(i + 1, close))
          i = end + 1
          continue
        }
      }
    }
    if (c === '!' && text[i + 1] === '[') {
      i++
      continue
    }
    if (c === '>' && (i === 0 || text[i - 1] === '\n')) {
      i++
      if (text[i] === ' ') i++
      continue
    }
    if ('*_~|`'.includes(c)) {
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/** The `]` closing the bracket at `open`, skipping escaped characters; -1 when there is none. */
function closingBracket(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === ']') return i
    else if (text[i] === '\n') return -1
  }
  return -1
}

function closingParen(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === ')') return i
  }
  return -1
}

/** CommonMark and GitHub Markdown: emphasis, code, headings, quotes and links lose their markers. */
function fromMarkdown(text: string): string {
  return text
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
}

export function plainText(text: string, format: MessageFormat): string {
  const plain = format === 'markdownv2' ? fromMarkdownV2(text) : format === 'markdown' ? fromMarkdown(text) : text
  return plain.replace(/[ \t]+\n/g, '\n').trim()
}
