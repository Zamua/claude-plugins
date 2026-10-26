import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, BoardItem, BoardSection } from '../types'

const PANE = 'session-board'
const TITLE = 'Session board'
const TOOL = 'mcp__session-board__board'
const SHAPE = 'board-1'
const SAVED_BOARDS = 40

const SECTIONS: readonly { key: BoardSection; title: string; prefix: string }[] = [
  { key: 'next', title: 'Next', prefix: 'n' },
  { key: 'questions', title: 'Open questions', prefix: 'q' },
  { key: 'decisions', title: 'Decisions', prefix: 'd' },
  { key: 'links', title: 'Links', prefix: 'l' },
  { key: 'ideas', title: 'Ideas', prefix: 'i' },
  { key: 'topics', title: 'Topics', prefix: 't' },
]

const TOOL_DESCRIPTION = `Update the session board, the pane beside the chat where the person sees what this session tracks. Keep it current unasked, so they never have to ask you to repeat something. Update it in the same turn something changes, batching changes into one call:
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

const REMINDER = `The person keeps a session board pane beside the chat. Keep it current with ${TOOL}, as its description says.`

const SECTION_KEYS = SECTIONS.map(section => section.key)

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    goal: {
      type: 'string',
      description: 'One line on what this session is for. Replaces the goal.',
    },
    summary: {
      type: 'string',
      description:
        'One to three short lines on where things stand now, markdown. Replaces the summary.',
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

type ItemAdd = { section: BoardSection; text: string; url?: string }
type ItemUpdate = { id: string; text?: string; url?: string; isDone?: boolean }
type BoardInput = {
  goal?: string
  summary?: string
  add?: ItemAdd[]
  update?: ItemUpdate[]
  remove?: string[]
}
type Applied = { board: Board; added: string[] } | { error: string }

const emptyBoard = (sessionId: string): Board => ({
  sessionId,
  goal: '',
  summary: '',
  items: [],
  seq: 0,
})

const board = atom(
  { plugin: 'session-board', key: 'board' } as const,
  emptyBoard(''),
  { shape: SHAPE },
)
const isDismissed = atom(
  { plugin: 'session-board', key: 'isDismissed' } as const,
  false,
)

const hasContent = (b: Board) =>
  b.goal !== '' || b.summary !== '' || b.items.length > 0

const prefixOf = (section: BoardSection) =>
  SECTIONS.find(one => one.key === section)?.prefix ?? 'x'

const patch = (item: BoardItem, change: ItemUpdate): BoardItem => ({
  ...item,
  ...(change.text !== undefined && { text: change.text }),
  ...(change.url !== undefined && { url: change.url }),
  ...(change.isDone !== undefined && { isDone: change.isDone }),
})

function apply(current: Board, input: BoardInput): Applied {
  const known = new Set(current.items.map(item => item.id))
  const unknown = [
    ...(input.remove ?? []),
    ...(input.update ?? []).map(change => change.id),
  ].filter(id => !known.has(id))
  if (unknown.length > 0) {
    return {
      error: `No board item ${unknown.join(', ')}. Call with no fields to list the ids.`,
    }
  }
  const stray = (input.add ?? []).find(one => !SECTION_KEYS.includes(one.section))
  if (stray) {
    return { error: `No board section ${String(stray.section)}.` }
  }

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
    items.push({
      id,
      section: one.section,
      text: one.text,
      ...(one.url ? { url: one.url } : {}),
    })
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

function describe(b: Board): string {
  const lines = [
    `goal: ${b.goal || '(none)'}`,
    `summary: ${b.summary || '(none)'}`,
  ]
  for (const section of SECTIONS) {
    const items = b.items.filter(item => item.section === section.key)
    if (items.length === 0) continue
    lines.push(`${section.key}:`)
    for (const item of items) {
      const done = item.isDone ? ' [done]' : ''
      const url = item.url ? ` <${item.url}>` : ''
      lines.push(`  ${item.id}${done} ${item.text}${url}`)
    }
  }

  return lines.join('\n')
}

const mark = (item: BoardItem) => {
  if (item.isDone) return '✓'

  return item.section === 'next' || item.section === 'questions' ? '○' : '•'
}

const lineOf = (item: BoardItem) => {
  const label = item.text.replace(/[[\]]/g, '\\$&')
  const body = item.url ? `[${label}](${item.url})` : item.text

  return `${mark(item)} ${body} \`${item.id}\``
}

const storeKey = (sessionId: string) => `board:${sessionId}`

async function loadSaved($: EngineInterface, sessionId: string): Promise<Board> {
  const saved = await $.store.get(storeKey(sessionId))
  const isBoard =
    typeof saved === 'object' &&
    saved !== null &&
    (saved as { shape?: unknown }).shape === SHAPE

  return isBoard ? (saved as { value: Board }).value : emptyBoard(sessionId)
}

async function save($: EngineInterface, value: Board) {
  const key = storeKey(value.sessionId)
  await $.store.set(key, { shape: SHAPE, value })
  const older = (await $.store.keys()).filter(
    one => one.startsWith('board:') && one !== key,
  )
  for (const one of older.slice(0, Math.max(0, older.length - SAVED_BOARDS + 1))) {
    await $.store.delete(one)
  }
}

// session.start fires once per process, not after /clear or /resume, so every
// entry point re-checks which session it is in.
async function syncSession($: EngineInterface) {
  const sessionId = await $.session.id()
  if ((await read($, board)).sessionId === sessionId) return
  const loaded = await loadSaved($, sessionId)
  await update($, board, () => loaded)
  await update($, isDismissed, () => false)
}

async function change(
  $: EngineInterface,
  fn: (current: Board) => Applied,
): Promise<Applied> {
  const out: { applied?: Applied } = {}
  await update($, board, current => {
    out.applied = fn(current)

    return 'board' in out.applied ? out.applied.board : current
  })

  return out.applied ?? { error: 'The board did not change.' }
}

async function show($: EngineInterface) {
  if (await read($, isDismissed)) return
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'board',
      description: TOOL_DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'board',
      description: 'Open the session board, or empty it with /board clear',
      argumentHint: '[clear]',
    })
    await syncSession($)
    if (hasContent(await read($, board))) void show($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await syncSession($)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed

    return {
      sections: [
        ...composed.sections,
        { id: 'session-board:guide', text: REMINDER, scope: 'session' as const },
      ],
    }
  })

  on('tool.check', { tool: TOOL }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) {
      return { deny: 'The session board belongs to the main conversation.' }
    }
    const { tool, tool_use_id, consent, agentId, ...args } = e
    const input = args as BoardInput
    await syncSession($)

    const isRead =
      input.goal === undefined &&
      input.summary === undefined &&
      !input.add?.length &&
      !input.update?.length &&
      !input.remove?.length
    if (isRead) return { result: describe(await read($, board)) }

    const applied = await change($, current => apply(current, input))
    if ('error' in applied) return { deny: applied.error }
    await save($, applied.board)
    void show($)

    return {
      result:
        applied.added.length > 0
          ? `Board updated. Added ${applied.added.join(', ')}.`
          : 'Board updated.',
    }
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    await syncSession($)
    if (e.args.trim() === 'clear') {
      const applied = await change($, current => ({
        board: emptyBoard(current.sessionId),
        added: [],
      }))
      if ('board' in applied) await save($, applied.board)

      return { text: 'Session board cleared.' }
    }
    await update($, isDismissed, () => false)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced
        ? 'Session board opened.'
        : `Session board is waiting for room: ${opened.reason}`,
    }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, isDismissed, () => true)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const b = await read($, board)
    if (!hasContent(b)) {
      return (
        <Text dimColor>
          Nothing tracked yet. Claude fills this in as the session goes.
        </Text>
      )
    }
    const filled = SECTIONS.map(section => ({
      ...section,
      items: b.items.filter(item => item.section === section.key),
    })).filter(section => section.items.length > 0)

    return (
      <Box flexDirection="column" gap={1}>
        {b.goal !== '' && <Text bold>{b.goal}</Text>}
        {b.summary !== '' && <Markdown text={b.summary} />}
        {filled.map(section => (
          <Box flexDirection="column">
            <Text color="claude" bold>
              {section.title}
            </Text>
            {[
              ...section.items.filter(item => !item.isDone),
              ...section.items.filter(item => item.isDone),
            ].map(item => (
              <Markdown dimColor={item.isDone === true} text={lineOf(item)} />
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
