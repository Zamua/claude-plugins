import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export const HOME = '/home/test'
export const CONFIG_FILE = `${HOME}/.config/board/boards.json`

type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }
type Ran = { exitCode: number; stdout: string; stderr: string }

/** What the stand-in engine holds and records: files on disk, open panes, and every call that leaves the plugin. */
export type World = {
  session: { id: string }
  env: Record<string, string>
  files: Record<string, string>
  /** What the plugin's own store holds at the start. */
  store: Record<string, unknown>
  panes: Pane[]
  opens: { id: string; title?: string; focus?: boolean }[]
  closes: { id: string }[]
  toasts: string[]
  runs: string[][]
  fills: { text: string }[]
  run: (argv: readonly string[]) => Ran | undefined
  /** Answers for tools other plugins serve, by tool name, such as an MCP server's. */
  mcp: Record<string, (input: Record<string, unknown>) => unknown>
  /** Every call the plugin made to one of those tools, with its input. */
  toolCalls: { tool: string; input: Record<string, unknown> }[]
}

export function world(over: Partial<World> = {}): World {
  return {
    session: { id: 's1' },
    env: {},
    files: {},
    store: {},
    panes: [],
    opens: [],
    closes: [],
    toasts: [],
    runs: [],
    fills: [],
    run: () => undefined,
    mcp: {},
    toolCalls: [],
    ...over,
  }
}

export const json = (value: unknown) => JSON.stringify(value)

/** Nothing sits beneath the plugin in a test, so each hook here answers as the engine would. */
export function engine(on: On, w: World, now: number) {
  const clock = mock.clock(on, { now })
  mock.store(on, w.store)
  mock.env(on, { HOME, ...w.env })
  on('session.id', () => ({ value: w.session.id }))
  on('fs.exists', (_, e) => ({ value: e.path in w.files || Object.keys(w.files).some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.list', (_, e) => {
    const dir = `${e.path}/`
    const names = [...new Set(Object.keys(w.files).filter(p => p.startsWith(dir)).map(p => p.slice(dir.length).split('/')[0] ?? ''))]

    return {
      value: names.map(name => {
        const text = w.files[dir + name]

        return { name, kind: text === undefined ? ('dir' as const) : ('file' as const), size: (text ?? '').length, mtimeMs: 1, isLink: false }
      }),
    }
  })
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: (w.files[e.path] ?? '').length, mtimeMs: (w.files[e.path] ?? '').length, isLink: false },
  }))
  on('fs.read', (_, e) => ({ value: w.files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('ui.open', (_, e) => {
    w.opens.push(e)
    const pane = { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: e.focus === true, isPlaced: true }
    w.panes = [...w.panes.filter(p => p.id !== e.id), pane]
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.close', (_, e) => {
    w.closes.push(e)
    w.panes = w.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    w.fills.push(e)
    return { isFilled: true, box: { text: e.text, cursor: e.text.length } }
  })
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    const ran = w.run(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }
    return { value: { ...ran, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  for (const [tool, answer] of Object.entries(w.mcp)) {
    const exactly = new RegExp(`^${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    on('tool.call', { tool: exactly }, (_, e) => {
      const { tool: _name, tool_use_id: _id, consent: _consent, agentId: _agent, ...input } = e as unknown as Record<string, unknown>
      w.toolCalls.push({ tool, input })
      return { result: JSON.stringify(answer(input)) }
    })
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

  return clock
}

export const start = ($: Engine) => $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })

export const PANE = {
  plugin: 'board',
  component: 'Pane',
  requestId: 'board',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'Board',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** The person typing `/board <args>` at the prompt. */
export const board = ($: Engine, args = '') =>
  $.command.run({
    command: 'board',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 160 },
  })

/** The pane as the person sees it after typing `/board <args>`. */
export async function open($: Engine, args = '', surface: 'terminal' | 'desktop' = 'terminal') {
  await board($, args)

  return $.ui.mount({ ...PANE, surface })
}
