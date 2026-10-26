import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { messageOf } from './kit'
import type { View } from './kit'
import { PANE, showView, TITLE } from './pane'
import { fileBoard, fileStart, fileView } from './views/file'
import type { FileBoard, FileBoardSpec, LinkPair } from './views/file'
import { prsHooks, prsStart, prsSync, prsView } from './views/prs'
import { reviewStart, reviewSync, reviewView } from './views/review'
import { sessionHooks, sessionStart, sessionSync, sessionView } from './views/session'

const CONFIG_PATH = '.config/board/boards.json'
const BUILT_IN = ['session', 'prs', 'review']
// Which view the pane opens on when several want it at the start of a session
const START_ORDER = ['review', 'session', 'prs']

const selected = atom({ plugin: 'board', key: 'selected' } as const, '')
const isDismissed = atom({ plugin: 'board', key: 'isDismissed' } as const, false)
const seenSession = atom({ plugin: 'board', key: 'sessionId' } as const, '')

type Config = { boards?: unknown[]; link_labels?: Record<string, string>; link_pairs?: LinkPair[] }

let fileBoards: FileBoard[] = []

const isSpec = (one: unknown): one is FileBoardSpec =>
  typeof one === 'object' &&
  one !== null &&
  typeof (one as FileBoardSpec).id === 'string' &&
  /^[a-z0-9-]+$/i.test((one as FileBoardSpec).id) &&
  typeof (one as FileBoardSpec).path === 'string'

async function readConfig($: EngineInterface, home: string): Promise<Config> {
  const path = (await $.env.get('BOARD_CONFIG')) || `${home}/${CONFIG_PATH}`
  try {
    if (!(await $.fs.exists(path))) return {}

    return JSON.parse(await $.fs.read(path)) as Config
  } catch (err) {
    $.ui.toast(`Could not read ${path}: ${messageOf(err)}`)

    return {}
  }
}

function viewsOf($: EngineInterface): View[] {
  return [sessionView($), prsView($), reviewView($), ...fileBoards.map(board => fileView($, board))]
}

/** The views the switcher lists: those with something to show, and the chosen one whatever it holds. */
async function listed($: EngineInterface): Promise<View[]> {
  const chosen = await read($, selected)
  const out: View[] = []
  for (const v of viewsOf($)) if (v.id === chosen || (await v.isAvailable())) out.push(v)

  return out
}

async function shown($: EngineInterface, list: View[]): Promise<View> {
  const chosen = await read($, selected)
  const found = list.find(v => v.id === chosen)
  if (found) return found
  for (const v of list) if ((await v.needs()) > 0) return v

  return list[0] ?? sessionView($)
}

// session.start fires once per process, not after /clear or /resume, so every entry point re-checks the session
async function sync($: EngineInterface) {
  const id = await $.session.id()
  if ((await read($, seenSession)) !== id) {
    await update($, seenSession, () => id)
    await update($, isDismissed, () => false)
    await update($, selected, () => '')
  }
  await sessionSync($)
  await prsSync($)
  await reviewSync($)
}

function match(views: View[], name: string): View | undefined {
  const lower = name.toLowerCase()
  const exact = views.find(v => v.id === lower || v.title.toLowerCase() === lower)
  if (exact) return exact
  const prefixed = views.filter(v => v.id.startsWith(lower) || v.title.toLowerCase().startsWith(lower))

  return prefixed.length === 1 ? prefixed[0] : undefined
}

export const register: Register = on => {
  sessionHooks(on)
  prsHooks(on)

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const config = await readConfig($, home)
    const shared = {
      labels: config.link_labels ?? {},
      pairs: Array.isArray(config.link_pairs) ? config.link_pairs : [],
    }
    const taken = new Set(BUILT_IN)
    fileBoards = []
    for (const spec of Array.isArray(config.boards) ? config.boards : []) {
      if (!isSpec(spec) || taken.has(spec.id)) continue
      taken.add(spec.id)
      fileBoards.push(fileBoard(spec, shared, home))
    }
    await sessionStart($)
    await prsStart($)
    await reviewStart($)
    for (const board of fileBoards) await fileStart($, board)
    await $.command.register({
      name: 'board',
      description: 'Show or hide the board pane, open it on one view, or empty a view with clear',
      argumentHint: `[${[...taken].join('|')}] [clear]`,
      immediate: true,
    })
    // Countdowns and ages move even when no board does
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    await sync($)
    const views = viewsOf($)
    for (const id of START_ORDER) {
      const v = views.find(one => one.id === id)
      if (v && (await v.opensAtStart?.())) {
        await showView($, v.id)
        break
      }
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await sync($)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const parts = viewsOf($).flatMap(v => (v.guide && e.tools.includes(v.guide.tool) ? [v.guide.text] : []))
    if (parts.length === 0) return composed
    const text = `The person keeps a board pane beside the chat: ${parts.join(', and ')}, as the tools' descriptions say.`

    return { sections: [...composed.sections, { id: 'board:guide', text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    await sync($)
    const views = viewsOf($)
    const ids = views.map(v => v.id)
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const isBareClear = words.length === 1 && words[0] === 'clear'
    const name = isBareClear ? '' : (words[0] ?? '')
    const verb = isBareClear ? 'clear' : (words[1] ?? '')
    const named = name ? match(views, name) : undefined
    if (name && !named) return { text: `No board named ${name}. Boards: ${ids.join(', ')}.` }
    if (verb && verb !== 'clear') return { text: `Usage: /board [${ids.join('|')}] [clear]` }
    const current = await shown($, await listed($))

    if (verb === 'clear') {
      const target = named ?? current
      if (!target.clear) return { text: `The ${target.id} board has nothing to clear.` }

      return { text: await target.clear() }
    }

    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isPlaced && (!named || named.id === current.id)) {
      await $.ui.close({ id: PANE })
      await update($, isDismissed, () => true)

      return {}
    }
    const target = named ?? current
    await update($, selected, () => target.id)
    await update($, isDismissed, () => false)
    await target.onShow?.()
    // No closeOnEscape: Esc hands the keys back to the prompt and the board stays docked
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isDismissed, () => true)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const list = await listed($)
    const current = await shown($, list)
    const counts = await Promise.all(list.map(v => v.needs()))

    return (
      <Box key="board" flexDirection="column">
        <Box key="switcher" flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1} marginBottom={1}>
          {list.flatMap((v, at) => {
            const isShown = v.id === current.id
            const count = counts[at] ?? 0

            return [
              ...(at > 0 ? [<Text dimColor>·</Text>] : []),
              <Button
                key={`tab-${v.id}`}
                plain
                onPress={async () => {
                  await update($, selected, () => v.id)
                  await v.onShow?.()
                }}
              >
                <Text bold={isShown || undefined} color={isShown ? 'claude' : undefined} dimColor={!isShown || undefined}>
                  {v.title}
                </Text>
                {count > 0 && (
                  <Text color="warning" bold>
                    {` ${count}`}
                  </Text>
                )}
              </Button>,
            ]
          })}
        </Box>
        {await current.render(els)}
      </Box>
    )
  })
}
