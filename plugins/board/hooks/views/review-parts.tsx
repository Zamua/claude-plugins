// The review view's pieces. What the person ticked and opened is passed in; choosing a stack is a callback, so the
// stack atom stays with the view that reads it.
import type { Color, EngineInterface, RenderNode } from 'claude-code'

import type { TrackedPr } from '../../types'
import { ago, fixed, link } from '../kit'
import type { Els, SectionSpec } from '../kit'
import { prTable } from './prs'
import type { GithubFacts } from './prs'
import { isPickable, otherOpen, prOf } from './review-board'
import type { Board, Comment, Pr, ReportSection, Stack } from './review-board'

const STATUS_TAGS: Record<string, { text: string; color: Color }> = {
  approved: { text: 'approved', color: 'warning' },
  posted: { text: 'posted', color: 'success' },
}
const RISK_COLORS: Record<string, Color> = { high: 'error', medium: 'warning', low: 'success' }
// Where a finding comes from, measured against the code path the change replaces
const ORIGIN_TAGS: Record<string, { text: string; color: Color }> = {
  new: { text: 'new', color: 'error' },
  carried: { text: 'carried over', color: 'inactive' },
  none: { text: 'not a bug', color: 'inactive' },
}

/** Narrows the view to a stack by id; empty is All. */
export type ChooseStack = (id: string) => unknown

/** A pull request of the review as the prs board tracks one, with what GitHub last said of it. */
export function trackedOf(p: Pr, github: GithubFacts): TrackedPr {
  const [path = '', number = ''] = p.pr.split('#')
  const [owner = '', repo = ''] = path.split('/')
  const facts = github.facts.get(p.pr)

  return {
    key: p.pr,
    owner,
    repo,
    number: p.number || Number(number),
    url: p.url || `https://github.com/${path}/pull/${number}`,
    note: '',
    stack: '',
    ...(facts && { facts }),
  }
}

function labelled(els: Els, key: string, label: string, sentence: string) {
  const { Box, Text } = els

  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Text dimColor>{label.padEnd(5)}</Text>
      <Text wrap="wrap">{sentence}</Text>
    </Box>
  )
}

function toggler($: EngineInterface, expanded: Set<string>, id: string) {
  return async () => {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    $.ui.invalidate('ui.render')
  }
}

/**
 * The view's head: the review's title, verdict, risk and blast radius in All, a stack's own in its view. Once
 * something was posted and nothing waits, neither a comment to decide nor a thread on the author, it says all
 * addressed.
 */
export function header(els: Els, b: Board, slug: string, stack: Stack | undefined, comments: Comment[]) {
  const { Box, Text } = els
  const source = stack ?? b
  const title = stack ? stack.title : b.title || slug
  const posted = comments.filter(c => c.status === 'posted')
  const waiting =
    posted.some(c => !c.addressed) ||
    comments.some(isPickable) ||
    otherOpen(stack ? stack.prs : Array.isArray(b.prs) ? b.prs : []) > 0

  return (
    <Box key="summary" flexDirection="column" paddingX={1}>
      <Box key="title-row" flexDirection="row" columnGap={1}>
        <Text bold>{title}</Text>
        {source.verdict && <Text color={RISK_COLORS[source.verdict] ?? 'warning'}>{source.verdict}</Text>}
        {posted.length > 0 && !waiting && <Text color="success">all addressed</Text>}
      </Box>
      {source.risk && labelled(els, 'risk', 'Risk', source.risk)}
      {source.blast_radius && labelled(els, 'blast', 'Blast', source.blast_radius)}
    </Box>
  )
}

/** All, then one button per stack; pressing one narrows the view to that stack's pull requests and comments. */
export function stackTabs(els: Els, stacks: readonly Stack[], chosen: Stack | undefined, choose: ChooseStack) {
  const { Box, Button, Text } = els
  const tabs = [{ id: '', title: 'All' }, ...stacks]

  return (
    <Box key="stack-tabs" flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1}>
      {tabs.flatMap((s, at) => {
        const isChosen = (chosen?.id ?? '') === s.id

        return [
          ...(at > 0 ? [<Text dimColor>·</Text>] : []),
          <Button key={`stack-tab-${s.id || 'all'}`} plain onPress={() => choose(s.id)}>
            <Text bold={isChosen || undefined} color={isChosen ? 'claude' : undefined} dimColor={!isChosen || undefined}>
              {s.title}
            </Text>
          </Button>,
        ]
      })}
    </Box>
  )
}

/** A stack's name and its verdict; in All the name is a button that narrows the view to the stack. */
function stackHeading(els: Els, key: string, stack: Stack, choose: ChooseStack | undefined) {
  const { Box, Text, Button } = els
  const name = <Text bold>{stack.title}</Text>

  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      {choose ? (
        <Button key={`goto-${stack.id}`} plain onPress={() => choose(stack.id)}>
          {name}
        </Button>
      ) : (
        name
      )}
      {stack.verdict && <Text color={RISK_COLORS[stack.verdict] ?? 'warning'}>{stack.verdict}</Text>}
    </Box>
  )
}

/**
 * The pull requests in view, drawn as the prs board draws them: one stack under its own heading, or, in All, every
 * stack under its own. Each keeps the board's short title.
 */
export function prList(els: Els, github: GithubFacts, b: Board, stacks: readonly Stack[], several: boolean, choose: ChooseStack) {
  const { Box } = els
  const titles = new Map((Array.isArray(b.prs) ? b.prs : []).flatMap(p => (p.title ? [[p.pr, p.title] as const] : [])))
  const groups = stacks.map(s => ({
    key: several ? `group-${s.id}` : 'prs-group',
    heading: several ? stackHeading(els, `stack-${s.id}`, s, choose) : stackHeading(els, 'prs-heading', s, undefined),
    prs: s.prs.map(p => trackedOf(p, github)),
  }))

  return (
    <Box key="prs" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
      {prTable(els, groups, github.viewer, p => titles.get(p.key))}
    </Box>
  )
}

function fileLinksOf(els: Els, c: Comment) {
  const out: RenderNode[] = []
  const seen = new Set<string>()
  const add = (href: string | undefined, label: string, style: { color?: Color; bold?: boolean; dimColor?: boolean }) => {
    if (!href || seen.has(href)) return
    seen.add(href)
    out.push(link(els, href, label, style))
  }
  const files = Array.isArray(c.files) ? c.files : []
  add(c.location_url, c.target || 'code', { bold: true })
  for (const f of files) if (f && f.kind !== 'test') add(f.url, f.label || 'file', { dimColor: true })
  for (const f of files) if (f && f.kind === 'test') add(f.url, `test: ${f.label || 'scratch'}`, { color: 'suggestion' })
  add(c.posted_url, 'posted comment', { color: 'success' })

  return out
}

export function commentRow($: EngineInterface, els: Els, picks: Set<number>, expanded: Set<string>, c: Comment, prs: readonly Pr[]) {
  const { Box, Text, Button, Markdown } = els
  const picked = picks.has(c.n)
  const isOpen = expanded.has(`c${c.n}`)
  const toggle = async () => {
    if (picks.has(c.n)) picks.delete(c.n)
    else picks.add(c.n)
    $.ui.invalidate('ui.render')
  }
  const { number, url } = prOf(c, prs)
  const origin = c.origin ? ORIGIN_TAGS[c.origin] : undefined
  const tag = c.status ? STATUS_TAGS[c.status] : undefined
  const full: [string, string, string | undefined][] = [
    ['body', 'Posts as', c.body],
    ['detail', 'Finding', c.detail],
    ['origin', 'Origin', c.origin_note],
    ['status', 'Status', c.status_note],
  ]
  const shown = full.filter((one): one is [string, string, string] => Boolean(one[2]))
  const files = fileLinksOf(els, c)

  return (
    <Box key={`comment-${c.n}`} flexDirection="column">
      <Box key={`head-${c.n}`} flexDirection="row" columnGap={1}>
        {isPickable(c) ? (
          <Button key={`pick-${c.n}`} label={picked ? '[x]' : '[ ]'} plain dimColor={!picked} onPress={toggle} />
        ) : (
          <Text dimColor>{'   '}</Text>
        )}
        <Button key={`expand-${c.n}`} label={isOpen ? '▾' : '▸'} plain dimColor onPress={toggler($, expanded, `c${c.n}`)} />
        {fixed(els, `num-${c.n}`, <Text bold>{String(c.n).padStart(2)}</Text>)}
        {fixed(els, `prlink-${c.n}`, url ? link(els, url, `#${number}`) : <Text dimColor>{`#${number}`}</Text>)}
        {c.confidence !== 'proven' && <Text dimColor>?</Text>}
        {origin && <Text color={origin.color}>{origin.text}</Text>}
        {tag && <Text color={tag.color}>{tag.text}</Text>}
      </Box>
      <Box key={`body-${c.n}`} flexDirection="column" paddingLeft={6}>
        <Text wrap="wrap">{c.summary || c.target || ''}</Text>
        {isOpen && shown.length > 0 && (
          <Box key={`full-${c.n}`} flexDirection="column" marginTop={1} marginBottom={1}>
            {shown.flatMap(([id, label, text]) => [<Text dimColor>{label}</Text>, <Markdown key={`${id}-md-${c.n}`} text={text} />])}
          </Box>
        )}
      </Box>
      {files.length > 0 && (
        <Box key={`files-${c.n}`} flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={6}>
          {files}
        </Box>
      )}
    </Box>
  )
}

/** Comments already on GitHub, one line each: unaddressed ones wait on their author, and only addressed ones say how they were settled. */
export function followUpRows(els: Els, followUp: SectionSpec, comments: Comment[], prs: readonly Pr[]) {
  const { Box, Text } = els

  return comments.map(c => {
    const { number, url } = prOf(c, prs)
    const id = `${followUp.id}-${c.n}`

    return (
      <Box key={id} flexDirection="column">
        <Box key={`${followUp.id}-row-${c.n}`} flexDirection="row" columnGap={1}>
          {fixed(els, `${followUp.id}-num-${c.n}`, <Text dimColor>{String(c.n).padStart(2)}</Text>)}
          {fixed(
            els,
            `${followUp.id}-pr-${c.n}`,
            url ? link(els, url, `#${number}`, { dimColor: true }) : <Text dimColor>{`#${number}`}</Text>,
          )}
          {c.posted_url && fixed(els, `${followUp.id}-link-${c.n}`, link(els, c.posted_url, 'comment', { color: followUp.color }))}
          <Text dimColor wrap="truncate-end">
            {c.summary || c.target || ''}
          </Text>
        </Box>
        {c.addressed && c.addressed_note && (
          <Text dimColor wrap="wrap">
            {`   ${c.addressed_note}`}
          </Text>
        )}
      </Box>
    )
  })
}

/** The report's sections, one line each until opened, so the comments stay in view. */
export function reportBox($: EngineInterface, els: Els, expanded: Set<string>, sections: ReportSection[]) {
  const { Box, Text, Button, Markdown } = els

  return (
    <Box key="report" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
      <Box key="report-heading" flexDirection="row" columnGap={1}>
        <Text bold>Report</Text>
        <Text dimColor>{String(sections.length)}</Text>
      </Box>
      {sections.flatMap((s, i) => {
        const sid = s.id || String(i)
        const id = `r:${sid}`
        const isOpen = expanded.has(id)

        return [
          <Button
            key={`report-${sid}`}
            label={`${isOpen ? '▾ ' : '▸ '}${s.title || 'Section'}`}
            plain
            onPress={toggler($, expanded, id)}
          />,
          ...(isOpen && s.markdown
            ? [
                <Box key={`report-body-${sid}`} paddingLeft={2} marginBottom={1}>
                  <Markdown key={`report-md-${sid}`} text={s.markdown} />
                </Box>,
              ]
            : []),
        ]
      })}
    </Box>
  )
}

/** Ticking comments only drafts the reply; the person still sends it, so approval stays theirs. */
export function pickBar($: EngineInterface, els: Els, picks: Set<number>, tell: (notice: string | undefined) => void) {
  const { Box, Button } = els
  const picked = [...picks].sort((a, b) => a - b)
  if (picked.length === 0) return undefined
  const text = `post ${picked.join(', ')}`

  return (
    <Box key="pick-bar" flexDirection="row" columnGap={2} paddingX={1}>
      <Button
        key="fill"
        label={`Draft "${text}"`}
        plain
        onPress={async () => {
          const filled = await $.prompt.fill({ text })
          tell(filled && filled.isFilled === false ? `The prompt box is busy; type: ${text}` : undefined)
          $.ui.invalidate('ui.render')
        }}
      />
      <Button
        key="clear-picks"
        label="clear"
        plain
        dimColor
        onPress={async () => {
          picks.clear()
          $.ui.invalidate('ui.render')
        }}
      />
    </Box>
  )
}

export function freshness(b: Board | undefined, now: number, checkedAt: number) {
  const at = Date.parse(b?.updated_at ?? '')

  return [Number.isNaN(at) ? '' : `Updated ${ago(now - at)}`, checkedAt > 0 ? `GitHub checked ${ago(now - checkedAt)}` : '']
    .filter(Boolean)
    .join(' · ')
}
