import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { SessionBoard, SessionItem, SessionSection } from '../../types'
import type { View } from '../kit'
import { showView } from '../pane'
import { legacyValue, loadBoard, saveBoard } from '../store'

export const SESSION_TOOL = 'mcp__board__session'

const SECTIONS: readonly { key: SessionSection; title: string; prefix: string }[] = [
  { key: 'next', title: 'Next', prefix: 'n' },
  { key: 'questions', title: 'Open questions', prefix: 'q' },
  { key: 'decisions', title: 'Decisions', prefix: 'd' },
  { key: 'links', title: 'Links', prefix: 'l' },
  { key: 'ideas', title: 'Ideas', prefix: 'i' },
  { key: 'topics', title: 'Topics', prefix: 't' },
]

const TOOL_DESCRIPTION = `Update the session board, the view of the board pane beside the chat where the person sees what this session tracks. Keep it current unasked, so they never have to ask you to repeat something. Update it in the same turn something changes, batching changes into one call:
- goal: one line on what the session is for. Set it once the task is clear, revise it when the task changes.
- summary: one to three short lines on where things stand. Replace it at the end of any turn that moved the work.
- next: the next concrete steps. Mark them done as they finish.
- questions: open questions, for the person or still unresolved. When one is answered, fold the answer into its text and mark it done.
- decisions: what was decided, one line each.
- links: every PR, issue, doc, dashboard or other URL likely to be needed again, with a short label.
- ideas: ideas and follow-ups parked for later.
- topics: threads the session has covered.
Keep entries short, the board is for glancing. Do not mention board updates in your reply or repeat the board's contents unless asked. When the person names an item by its id (q3, l2), it is the board's.
Every field is optional and the changes apply together. Call with no fields to read the board and its item ids. Main conversation only.`

const SECTION_KEYS = SECTIONS.map(one => one.key)

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    goal: {
      type: 'string',
      description: 'One line on what this session is for. Replaces the goal.',
    },
    summary: {
      type: 'string',
      description: 'One to three short lines on where things stand now, markdown. Replaces the summary.',
    },
    add: {
      type: 'array',
      description: 'Items to add. Each gets an id, returned in the result.',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: SECTION_KEYS },
          text: { type: 'string', description: 'Short, markdown allowed.' },
          url: {
            type: 'string',
            description: 'Makes the text a link. Use for every links item.',
          },
        },
        required: ['section', 'text'],
      },
    },
    update: {
      type: 'array',
      description: 'Changes to existing items, by id.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          url: { type: 'string' },
          isDone: {
            type: 'boolean',
            description: 'A step finished or a question answered.',
          },
        },
        required: ['id'],
      },
    },
    remove: {
      type: 'array',
      description: 'Ids of items to delete outright.',
      items: { type: 'string' },
    },
  },
}

type ItemAdd = { section: SessionSection; text: string; url?: string }
type ItemUpdate = { id: string; text?: string; url?: string; isDone?: boolean }
type Input = {
  goal?: string
  summary?: string
  add?: ItemAdd[]
  update?: ItemUpdate[]
  remove?: string[]
}
type Applied = { board: SessionBoard; added: string[] } | { error: string }

const emptyBoard = (sessionId: string): SessionBoard => ({
  sessionId,
  goal: '',
  summary: '',
  items: [],
  seq: 0,
})

const SHAPE = 'session-1'
const board = atom({ plugin: 'board', key: 'session' } as const, emptyBoard(''), { shape: SHAPE })
const PREFIX = 'session'

// session.start fires once per process, not after /clear or /resume, so every entry point re-checks the session
async function syncBoard($: EngineInterface) {
  const sessionId = await $.session.id()
  if ((await read($, board)).sessionId !== sessionId) {
    const loaded = (await loadBoard<SessionBoard>($, PREFIX, SHAPE, sessionId)) ?? emptyBoard(sessionId)
    await update($, board, () => loaded)
  }
  await importLegacy($)
}

/**
 * The session-board plugin kept a board per session in its own store. The first sync of a session takes that board
 * in: whole when this board is empty, else the items this board lacks, with fresh ids.
 */
async function importLegacy($: EngineInterface) {
  const current = await read($, board)
  if (current.legacyImported) return
  let held: unknown
  try {
    held = await legacyValue($, 'session-board', `board:${current.sessionId}`)
  } catch {
    return
  }
  const old = (held as { shape?: string; value?: SessionBoard } | undefined)?.shape === 'board-1'
    ? (held as { value: SessionBoard }).value
    : undefined
  await update($, board, now => (now.sessionId === current.sessionId ? withLegacy(now, old) : now))
  if (old) await saveBoard($, PREFIX, SHAPE, await read($, board))
}

function withLegacy(current: SessionBoard, old: SessionBoard | undefined): SessionBoard {
  if (!old) return { ...current, legacyImported: true }
  if (!hasContent(current)) return { ...old, sessionId: current.sessionId, legacyImported: true }
  const keyOf = (item: SessionItem) => `${item.section}\n${item.url ?? item.text.trim().toLowerCase()}`
  const seen = new Set(current.items.map(keyOf))
  const items = [...current.items]
  let seq = current.seq
  for (const item of old.items) {
    if (seen.has(keyOf(item))) continue
    seen.add(keyOf(item))
    seq += 1
    items.push({ ...item, id: `${prefixOf(item.section)}${seq}` })
  }

  return {
    ...current,
    goal: current.goal || old.goal,
    summary: current.summary || old.summary,
    items,
    seq,
    legacyImported: true,
  }
}

const hasContent = (b: SessionBoard) => b.goal !== '' || b.summary !== '' || b.items.length > 0

const prefixOf = (key: SessionSection) => SECTIONS.find(one => one.key === key)?.prefix ?? 'x'

const patch = (item: SessionItem, change: ItemUpdate): SessionItem => ({
  ...item,
  ...(change.text !== undefined && { text: change.text }),
  ...(change.url !== undefined && { url: change.url }),
  ...(change.isDone !== undefined && { isDone: change.isDone }),
})

function apply(current: SessionBoard, input: Input): Applied {
  const known = new Set(current.items.map(item => item.id))
  const unknown = [...(input.remove ?? []), ...(input.update ?? []).map(change => change.id)].filter(
    id => !known.has(id),
  )
  if (unknown.length > 0) {
    return { error: `No board item ${unknown.join(', ')}. Call with no fields to list the ids.` }
  }
  const stray = (input.add ?? []).find(one => !SECTION_KEYS.includes(one.section))
  if (stray) return { error: `No board section ${String(stray.section)}.` }

  const removed = new Set(input.remove)
  const changes = new Map((input.update ?? []).map(change => [change.id, change]))
  const items = current.items
    .filter(item => !removed.has(item.id))
    .map(item => {
      const change = changes.get(item.id)

      return change ? patch(item, change) : item
    })
  let seq = current.seq
  const added: string[] = []
  for (const one of input.add ?? []) {
    seq += 1
    const id = `${prefixOf(one.section)}${seq}`
    items.push({ id, section: one.section, text: one.text, ...(one.url ? { url: one.url } : {}) })
    added.push(id)
  }

  return {
    board: {
      ...current,
      goal: input.goal ?? current.goal,
      summary: input.summary ?? current.summary,
      items,
      seq,
    },
    added,
  }
}

function describe(b: SessionBoard): string {
  const lines = [`goal: ${b.goal || '(none)'}`, `summary: ${b.summary || '(none)'}`]
  for (const one of SECTIONS) {
    const items = b.items.filter(item => item.section === one.key)
    if (items.length === 0) continue
    lines.push(`${one.key}:`)
    for (const item of items) {
      const done = item.isDone ? ' [done]' : ''
      const url = item.url ? ` <${item.url}>` : ''
      lines.push(`  ${item.id}${done} ${item.text}${url}`)
    }
  }

  return lines.join('\n')
}

const mark = (item: SessionItem) => {
  if (item.isDone) return '✓'

  return item.section === 'next' || item.section === 'questions' ? '○' : '•'
}

const lineOf = (item: SessionItem) => {
  const label = item.text.replace(/[[\]]/g, '\\$&')
  const body = item.url ? `[${label}](${item.url})` : item.text

  return `${mark(item)} ${body} \`${item.id}\``
}

async function change($: EngineInterface, fn: (current: SessionBoard) => Applied): Promise<Applied> {
  const out: { applied?: Applied } = {}
  await update($, board, current => {
    out.applied = fn(current)

    return 'board' in out.applied ? out.applied.board : current
  })

  return out.applied ?? { error: 'The board did not change.' }
}

export function sessionHooks(on: On) {
  on('tool.check', { tool: SESSION_TOOL }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: SESSION_TOOL }, async ($, e) => {
    if (e.agentId) return { deny: 'The session board belongs to the main conversation.' }
    const { tool, tool_use_id, consent, agentId, ...args } = e
    const input = args as Input
    await syncBoard($)

    const isRead =
      input.goal === undefined &&
      input.summary === undefined &&
      !input.add?.length &&
      !input.update?.length &&
      !input.remove?.length
    if (isRead) return { result: describe(await read($, board)) }

    const applied = await change($, current => apply(current, input))
    if ('error' in applied) return { deny: applied.error }
    await saveBoard($, PREFIX, SHAPE, applied.board)
    await showView($, 'session')

    return {
      result: applied.added.length > 0 ? `Board updated. Added ${applied.added.join(', ')}.` : 'Board updated.',
    }
  })
}

export async function sessionStart($: EngineInterface) {
  await $.tool.register({
    name: 'session',
    description: TOOL_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isDeferred: false,
  })
  await syncBoard($)
}

export async function sessionSync($: EngineInterface) {
  await syncBoard($)
}

export function sessionView($: EngineInterface): View {
  return {
    id: 'session',
    title: 'session',
    scope: 'session',
    guide: { tool: SESSION_TOOL, text: `keep its session view current with ${SESSION_TOOL}` },
    isAvailable: async () => true,
    needs: async () => (await read($, board)).items.filter(item => item.section === 'questions' && !item.isDone).length,
    opensAtStart: async () => hasContent(await read($, board)),
    clear: async () => {
      const applied = await change($, current => ({ board: emptyBoard(current.sessionId), added: [] }))
      if ('board' in applied) await saveBoard($, PREFIX, SHAPE, applied.board)

      return 'Session board cleared.'
    },
    render: async els => {
      const { Box, Text, Markdown } = els
      const b = await read($, board)
      if (!hasContent(b)) {
        return <Text dimColor>Nothing tracked yet. Claude fills this in as the session goes.</Text>
      }
      const filled = SECTIONS.map(one => ({
        ...one,
        items: b.items.filter(item => item.section === one.key),
      })).filter(one => one.items.length > 0)

      return (
        <Box flexDirection="column" gap={1}>
          {b.goal !== '' && <Text bold>{b.goal}</Text>}
          {b.summary !== '' && <Markdown text={b.summary} />}
          {filled.map(one => (
            <Box flexDirection="column">
              <Text color="claude" bold>
                {one.title}
              </Text>
              {[...one.items.filter(item => !item.isDone), ...one.items.filter(item => item.isDone)].map(item => (
                <Markdown dimColor={item.isDone === true} text={lineOf(item)} />
              ))}
            </Box>
          ))}
        </Box>
      )
    },
  }
}
