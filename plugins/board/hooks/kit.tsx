import type { Color, Elements, EngineInterface, RenderNode, RenderSurface } from 'claude-code'

export type Els = Elements[RenderSurface]

/**
 * One view of the board pane, drawn below the switcher row when chosen. The validator lets `$` reach only function
 * declarations, so a named function given `$` builds the view for each hook call, its closures carry `$`, and its
 * lasting state lives outside it.
 */
export type View = {
  id: string
  title: string
  /** Whose board it is: this session's alone, or one every session shares. */
  scope: 'session' | 'shared'
  /** Whether the switcher row lists it while another view is shown. */
  isAvailable: () => Promise<boolean>
  /** How many of its items wait on the person, drawn beside its name in the switcher row. */
  needs: () => Promise<number>
  /** Whether the pane opens on it, unasked, when the session starts. */
  opensAtStart?: () => Promise<boolean>
  onShow?: () => Promise<void>
  clear?: () => Promise<string>
  /** The instruction prompt.compose adds while `tool` is among the session's tools. */
  guide?: { tool: string; text: string }
  render: (els: Els) => Promise<RenderNode>
}

export function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export const ago = (ms: number) => (ms < 30_000 ? 'just now' : `${span(ms)} ago`)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export type Due = { text: string; color?: Color }

/** A deadline as a countdown inside a day, red inside two hours, and as a weekday and date beyond. */
export function dueOf(due: unknown, label: unknown, now: number): Due | undefined {
  if (typeof due !== 'string') return undefined
  const at = Date.parse(due)
  if (Number.isNaN(at)) return undefined
  const prefix = typeof label === 'string' && label ? `${label} ` : ''
  const ms = at - now
  if (ms < 0) return { text: `${prefix}overdue`, color: 'red' }
  if (ms < 2 * 3600e3) return { text: `${prefix}in ${span(ms)}`, color: 'red' }
  if (ms < 24 * 3600e3) return { text: `${prefix}in ${span(ms)}`, color: 'yellow' }
  const d = new Date(at)

  return { text: `${prefix}${DAYS[d.getUTCDay()]} ${d.toISOString().slice(5, 10)}` }
}

export async function openUrl($: EngineInterface, url: string): Promise<string | undefined> {
  try {
    const opened = await $.process.run(['open', url])

    return opened.exitCode === 0 ? undefined : `Could not open ${url}`
  } catch (err) {
    return `Could not open the link: ${messageOf(err)}`
  }
}

type HerdrList = { result: { workspaces: { label: string; workspace_id: string }[] } }

/** Raises the herdr workspace a label or id names; the text says why when it could not. */
export async function focusWorkspace($: EngineInterface, label: string): Promise<string | undefined> {
  try {
    const listed = await $.process.run(['herdr', 'workspace', 'list'])
    const workspaces = (JSON.parse(listed.stdout) as HerdrList).result.workspaces
    const match = workspaces.find(w => w.label === label || w.workspace_id === label)
    if (!match) return `No herdr workspace named ${label}.`
    const focused = await $.process.run(['herdr', 'workspace', 'focus', match.workspace_id])

    return focused.exitCode === 0 ? undefined : `herdr could not open ${label}.`
  } catch (err) {
    return `herdr failed: ${messageOf(err)}`
  }
}

const LINK_LABELS: [string, string][] = [
  ['slack.com', 'Slack'],
  ['linear.app', 'Linear'],
  ['github.com', 'GitHub'],
  ['notion.so', 'Notion'],
  ['notion.com', 'Notion'],
  ['grafana.net', 'Grafana'],
  ['statsig.com', 'Statsig'],
  ['rootly.com', 'Rootly'],
]

/** A short name for where a link lives, by its host; `extra` comes first, so a config can name its own hosts. */
export function sourceLabel(url: string, extra: Record<string, string> = {}): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return 'link'
  }
  for (const [suffix, label] of [...Object.entries(extra), ...LINK_LABELS]) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return label
  }

  return 'link'
}

/** A JSON file another process rewrites, as `refreshJson` last read it. */
export type JsonFile<T> = {
  value?: T | undefined
  error?: string | undefined
  isMissing?: boolean
  mtime?: number | undefined
  path?: string
}

/** Reads the file again once its mtime moves; true when what `file` holds changed. */
export async function refreshJson<T>($: EngineInterface, file: JsonFile<T>, path: string): Promise<boolean> {
  const before = [file.value, file.error, file.isMissing]
  if (path !== file.path) {
    file.path = path
    file.mtime = undefined
    file.value = undefined
    file.error = undefined
  }
  try {
    if (!(await $.fs.exists(path))) {
      file.value = undefined
      file.error = undefined
      file.isMissing = true
      file.mtime = undefined
    } else {
      file.isMissing = false
      const stat = await $.fs.stat(path)
      if (stat.mtimeMs !== file.mtime) {
        // The writer may be mid-write; a parse failure leaves mtime unset so the next poll retries
        file.value = JSON.parse(await $.fs.read(path)) as T
        file.mtime = stat.mtimeMs
        file.error = undefined
      }
    }
  } catch (err) {
    file.error = messageOf(err)
  }

  return before[0] !== file.value || before[1] !== file.error || before[2] !== file.isMissing
}

/** A part of a row that keeps its width, so a narrow pane cuts the row's trailing text instead of wrapping a number. */
export function fixed(els: Els, key: string, child: RenderNode) {
  const { Box } = els

  return (
    <Box key={key} flexShrink={0}>
      {child}
    </Box>
  )
}

/** How fresh the view is, on its own right-aligned first row so a view taller than the pane still shows it. */
export function stamp(els: Els, text: string, isError = false) {
  const { Box, Text } = els

  return (
    <Box key="stamp" flexDirection="row" justifyContent="flex-end" paddingX={1}>
      <Text color={isError ? 'error' : undefined} dimColor={!isError} wrap="wrap">
        {text}
      </Text>
    </Box>
  )
}

/** A hyperlink, drawn inside a Text so it can carry a color. */
export function link(
  els: Els,
  href: string,
  label: string,
  style: { color?: Color; bold?: boolean; dimColor?: boolean } = {},
) {
  const { Text, Link } = els

  return (
    <Text {...style}>
      <Link href={href} label={label} />
    </Text>
  )
}

export type SectionSpec = {
  id: string
  title: string
  color: Color
  isQuiet?: boolean
  /** The heading drawn in place of the title and a zero count. */
  empty?: string
}

/** A round border in the section's color around a bold heading, its count, and its rows. */
export function section(els: Els, spec: SectionSpec, count: number, rows: RenderNode[]) {
  const { Box, Text } = els
  const quiet = spec.isQuiet || undefined
  const heading =
    count === 0 && spec.empty ? (
      <Text bold color={spec.color}>
        {spec.empty}
      </Text>
    ) : (
      <Box key={`heading-${spec.id}`} flexDirection="row" columnGap={1}>
        <Text bold color={spec.color} dimColor={quiet}>
          {spec.title}
        </Text>
        <Text dimColor>{String(count)}</Text>
      </Box>
    )

  return (
    <Box
      key={`section-${spec.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={spec.color}
      borderDimColor={quiet}
      paddingX={1}
    >
      {heading}
      {rows}
    </Box>
  )
}

/** Once a pull request leaves review its state outranks approval in the one column they share. */
export function prMark(state: string | undefined, isApproved: boolean): { glyph: string; color: Color } | undefined {
  if (state === 'MERGED') return { glyph: '◆', color: 'merged' }
  if (state === 'CLOSED') return { glyph: '✕', color: 'error' }

  return isApproved ? { glyph: '✓', color: 'success' } : undefined
}

export type PrRowSpec = {
  id: string
  number: number
  url?: string
  /** The rule hung under a stack heading. */
  tree?: 'mid' | 'last'
  /** The first column: one glyph for approval, or for merged and closed. */
  mark?: { glyph: string; color: Color }
  /** The second column: a warning mark while it waits on the person. */
  isFlagged: boolean
  dot: Color
  /** Columns after the dot that keep their width, such as a state word or an author. */
  columns?: RenderNode[]
  /** The pull request it sits on, when that is not the row above. */
  on?: number | string
  title?: string
}

/**
 * One quiet line per pull request. The mark and the flag each hold a one-cell column that stays empty without
 * them, so the numbers line up, and the number, the dot and the columns keep their width so the title gives way.
 */
export function prRow(els: Els, spec: PrRowSpec) {
  const { Box, Text } = els
  const { id } = spec

  return (
    <Box key={`prrow-${id}`} flexDirection="row" columnGap={1}>
      {spec.tree && fixed(els, `tree-${id}`, <Text dimColor>{spec.tree === 'last' ? '└' : '├'}</Text>)}
      <Box key={`mark-${id}`} width={1} flexShrink={0}>
        {spec.mark && <Text color={spec.mark.color}>{spec.mark.glyph}</Text>}
      </Box>
      <Box key={`flag-${id}`} width={1} flexShrink={0}>
        {spec.isFlagged && (
          <Text color="warning" bold>
            !
          </Text>
        )}
      </Box>
      {fixed(
        els,
        `prnum-${id}`,
        spec.url ? link(els, spec.url, `#${spec.number}`) : <Text dimColor>{`#${spec.number}`}</Text>,
      )}
      {fixed(els, `dot-${id}`, <Text color={spec.dot}>●</Text>)}
      {spec.columns}
      {spec.on !== undefined && fixed(els, `base-${id}`, <Text dimColor>{`on #${spec.on}`}</Text>)}
      {spec.title !== undefined && spec.title !== '' && (
        <Text dimColor wrap="truncate-end">
          {spec.title}
        </Text>
      )}
    </Box>
  )
}
