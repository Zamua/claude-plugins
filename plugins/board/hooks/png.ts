import type { EngineInterface, RenderNode } from 'claude-code'

import { messageOf } from './kit'
import type { Els } from './kit'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_TIMEOUT_MS = 30_000

type Plain = { type: string; props: Record<string, unknown>; children?: unknown }

const plain =
  (type: string) =>
  ({ children, ...props }: Record<string, unknown>): Plain => ({ type, props, children })

/**
 * Stand-ins for the surface's elements. They build the same plain data a drawing does, so a view can be drawn whole
 * outside the pane, at any height.
 */
export const PLAIN_ELS = {
  Box: plain('Box'),
  Text: plain('Text'),
  Button: plain('Button'),
  Link: plain('Link'),
  Markdown: plain('Markdown'),
} as unknown as Els

// Claude Code's dark theme, near enough for a picture
const COLORS: Record<string, string> = {
  claude: '#d77757',
  success: '#4eba65',
  error: '#ff6b80',
  warning: '#ffc107',
  suggestion: '#b1b9f9',
  permission: '#b1b9f9',
  inactive: '#999999',
  merged: '#af87ff',
  red: '#ff6b80',
  yellow: '#ffc107',
  green: '#4eba65',
}
const TEXT = '#e6e6e6'
const BACKGROUND = '#1e1e1e'
const LINE_EM = 1.35

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const colorOf = (name: unknown) => (typeof name === 'string' ? (COLORS[name] ?? name) : undefined)
const cells = (n: unknown) => (typeof n === 'number' ? `${n}ch` : undefined)
const lines = (n: unknown) => (typeof n === 'number' ? `${n * LINE_EM}em` : undefined)

function css(rules: Record<string, string | undefined>) {
  return Object.entries(rules)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}:${value}`)
    .join(';')
}

function boxStyle(p: Record<string, unknown>) {
  const border = typeof p.borderStyle === 'string' && p.borderStyle !== 'none' && p.borderStyle !== 'quote'
  const x = p.paddingX ?? p.padding
  const y = p.paddingY ?? p.padding

  const floats = p.position === 'absolute'

  return css({
    display: p.display === 'none' ? 'none' : 'flex',
    position: floats ? 'absolute' : 'relative',
    top: floats ? lines(p.top) : undefined,
    left: floats ? cells(p.left) : undefined,
    // A floating box covers the rows it is drawn over, as its padded cells do in the terminal
    background: floats ? BACKGROUND : undefined,
    'flex-direction': p.flexDirection === 'column' ? 'column' : 'row',
    'flex-wrap': p.flexWrap === 'wrap' ? 'wrap' : undefined,
    'justify-content': typeof p.justifyContent === 'string' ? p.justifyContent : undefined,
    'align-items': typeof p.alignItems === 'string' ? p.alignItems : undefined,
    'column-gap': cells(p.columnGap ?? p.gap),
    'row-gap': lines(p.rowGap ?? p.gap),
    'padding-left': cells(p.paddingLeft ?? x),
    'padding-right': cells(p.paddingRight ?? x),
    'padding-top': lines(p.paddingTop ?? y),
    'padding-bottom': lines(p.paddingBottom ?? y),
    'margin-top': lines(p.marginTop ?? p.marginY ?? p.margin),
    'margin-bottom': lines(p.marginBottom ?? p.marginY ?? p.margin),
    'margin-left': cells(p.marginLeft ?? p.marginX ?? p.margin),
    'margin-right': cells(p.marginRight ?? p.marginX ?? p.margin),
    width: cells(p.width),
    'flex-shrink': typeof p.flexShrink === 'number' ? String(p.flexShrink) : undefined,
    'flex-grow': typeof p.flexGrow === 'number' ? String(p.flexGrow) : undefined,
    'min-width': '0',
    border: border ? `1px solid ${colorOf(p.borderColor) ?? TEXT}` : undefined,
    'border-radius': p.borderStyle === 'round' ? '6px' : undefined,
    'border-left': p.borderStyle === 'quote' ? `2px solid ${colorOf(p.borderColor) ?? TEXT}` : undefined,
  })
}

function textStyle(p: Record<string, unknown>) {
  const truncates = typeof p.wrap === 'string' && p.wrap.startsWith('truncate')

  return css({
    color: colorOf(p.color),
    'font-weight': p.bold ? 'bold' : undefined,
    'font-style': p.italic ? 'italic' : undefined,
    'text-decoration': p.underline ? 'underline' : p.strikethrough ? 'line-through' : undefined,
    opacity: p.dimColor ? '0.55' : undefined,
    'white-space': truncates ? 'nowrap' : 'pre-wrap',
    overflow: truncates ? 'hidden' : undefined,
    'text-overflow': truncates ? 'ellipsis' : undefined,
    'min-width': truncates ? '0' : undefined,
  })
}

/** A drawn tree as HTML: Boxes as flex boxes measured in cells and lines, Text as styled spans. */
export function toHtml(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escape(String(node))
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const { type, props = {}, children } = node as Plain
  const inner = toHtml(children)
  if (type === 'Box') return `<div style="${boxStyle(props)}">${inner}</div>`
  if (type === 'Text') return `<span style="${textStyle(props)}">${inner}</span>`
  if (type === 'Button') return `<span style="${textStyle(props)}">${inner || escape(String(props.label ?? ''))}</span>`
  if (type === 'Link') return `<span>${escape(String(props.label ?? props.href ?? ''))}</span>`
  if (type === 'Markdown') return `<div style="${textStyle(props)}">${escape(String(props.text ?? ''))}</div>`

  return inner
}

function page(body: string, columns: number) {
  const style = `body{margin:0;background:${BACKGROUND};color:${TEXT};font:14px/${LINE_EM} Menlo,monospace}#root{display:inline-flex;flex-direction:column;width:${columns}ch;padding:12px 16px}`
  // The root's size, read by a first headless pass, sets the window of the second, which takes the picture
  const measure = `<script>const r=document.getElementById('root').getBoundingClientRect();document.body.dataset.w=Math.ceil(r.width);document.body.dataset.h=Math.ceil(r.height)</script>`

  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body><div id="root">${body}</div>${measure}</body></html>`
}

const pad = (n: number) => String(n).padStart(2, '0')

function stampOf(ms: number) {
  const d = new Date(ms)

  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * Draws `tree` at the pane's width and no height limit with headless Chrome, saves it to the Desktop and puts it on
 * the clipboard. The text says where it went, or why it could not.
 */
export async function exportPng($: EngineInterface, name: string, tree: RenderNode, columns: number): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  if (!(await $.fs.exists(CHROME))) return `Exporting a board needs Google Chrome at ${CHROME}.`
  const html = `${home}/.cache/board/export.html`
  const out = `${home}/Desktop/board-${name}-${stampOf(await $.clock.now())}.png`
  const chrome = [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${home}/.cache/board/chrome`]
  try {
    await $.fs.write(html, page(toHtml(tree), columns))
    const measured = await $.process.run([...chrome, '--window-size=4000,1000', '--dump-dom', `file://${html}`], {
      timeoutMs: CHROME_TIMEOUT_MS,
    })
    const width = Number(/data-w="(\d+)"/.exec(measured.stdout)?.[1])
    const height = Number(/data-h="(\d+)"/.exec(measured.stdout)?.[1])
    if (!width || !height) return `Chrome could not lay the board out: ${measured.stderr.trim().split('\n')[0] || 'no size came back'}.`
    const shot = await $.process.run(
      [...chrome, '--force-device-scale-factor=2', `--window-size=${width},${height}`, `--screenshot=${out}`, `file://${html}`],
      { timeoutMs: CHROME_TIMEOUT_MS },
    )
    if (shot.exitCode !== 0 || !(await $.fs.exists(out))) return `Chrome could not take the picture: ${shot.stderr.trim().split('\n')[0]}.`
    const copied = await $.process.run(['osascript', '-e', `set the clipboard to (read (POSIX file "${out}") as «class PNGf»)`])

    return copied.exitCode === 0 ? `Saved ${out} and copied it to the clipboard.` : `Saved ${out}; it could not go on the clipboard.`
  } catch (err) {
    return `Could not export the board: ${messageOf(err)}`
  }
}
