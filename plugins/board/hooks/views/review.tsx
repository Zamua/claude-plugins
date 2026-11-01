import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderNode } from 'claude-code'

import { refreshJson, section, stamp } from '../kit'
import type { JsonFile, View } from '../kit'
import { factsFor } from './prs'
import type { GithubFacts } from './prs'
import { commentsOf, FOLLOW_UPS, isPickable, prsFromState, SEVERITIES, severityOf, stackOf, stacksOf, withFacts } from './review-board'
import type { Board, Facts, Pr } from './review-board'
import { commentRow, followUpRows, freshness, header, pickBar, prList, reportBox, stackTabs, trackedOf } from './review-parts'

// The poller records every review here; the worker running one is the session it records
const STATE_PATH = '.config/pr-review-board/state.json'
const CONFIG_PATH = '.config/pr-review-board/config.json'
const POLL_MS = 10_000
const FACTS_MS = 60_000

type Review = { key: string; slug: string; prs: Pr[]; boardPath: string }
type PollerState = { reviews?: Record<string, { status?: string; slug?: string; claude_session?: string; herdr_workspace?: string; prs?: string[] }> }

const stackChoice = atom({ plugin: 'board', key: 'reviewStack' } as const, '')

let home = ''
let sessionId = ''
let workspaceId: string | undefined
let review: Review | undefined
let board: Board | undefined
let readError: string | undefined
// Where this session's hand-written board goes, so the empty view can say where to write one
let manualPath = ''
const file: JsonFile<Board> = {}
const factsFile: JsonFile<Facts> = {}
let merged: { raw?: Board | undefined; facts?: Facts | undefined; value?: Board | undefined } = {}
let github: GithubFacts = { facts: new Map(), viewer: '', checkedAt: 0, error: '' }
let factsKeys = ''
let factsAt = 0
// Comment numbers ticked for the next post, and the comments and report sections shown in full; kept only for this module's life
const picks = new Set<number>()
const expanded = new Set<string>()
let notice: string | undefined

async function reviewsRoot($: EngineInterface) {
  try {
    const path = (await $.env.get('PR_REVIEW_BOARD_CONFIG')) || `${home}/${CONFIG_PATH}`
    if (await $.fs.exists(path)) {
      const root = (JSON.parse(await $.fs.read(path)) as { reviews_root?: string }).reviews_root
      if (root) return root.startsWith('~/') ? home + root.slice(1) : root
    }
  } catch {
    // An unreadable config falls back to the harness default
  }

  return `${home}/workspace/reviews`
}

/** A review the poller spawned: the one that recorded this session, else the one bound to this herdr workspace. */
async function spawnedReview($: EngineInterface, root: string): Promise<Review | undefined> {
  const path = (await $.env.get('PR_REVIEW_BOARD_STATE')) || `${home}/${STATE_PATH}`
  if (!(await $.fs.exists(path))) return undefined
  const state = JSON.parse(await $.fs.read(path)) as PollerState
  const active = Object.entries(state.reviews ?? {}).filter(([, r]) => r && r.status === 'ACTIVE')
  const match =
    active.find(([, r]) => r.claude_session && r.claude_session === sessionId) ??
    (workspaceId ? active.find(([, r]) => r.herdr_workspace === workspaceId) : undefined)
  if (!match) return undefined
  const [key, r] = match

  return { key, slug: r.slug || key, prs: prsFromState(r.prs), boardPath: `${root}/.pr-review-board/${key}/board.json` }
}

export async function reviewRefresh($: EngineInterface) {
  const before = [review?.key, board, readError]
  try {
    const root = await reviewsRoot($)
    manualPath = `${root}/.pr-review-board/manual-${sessionId}/board.json`
    const key = `manual-${sessionId}`
    review =
      (await spawnedReview($, root)) ??
      ((await $.fs.exists(manualPath)) ? { key, slug: key, prs: [], boardPath: manualPath } : undefined)
    if (review) {
      await refreshJson($, factsFile, review.boardPath.replace(/board\.json$/, 'github.json'))
      await refreshJson($, file, review.boardPath)
      // The same inputs give back the same board, so an unchanged poll redraws nothing
      if (file.value !== merged.raw || factsFile.value !== merged.facts) {
        merged = { raw: file.value, facts: factsFile.value, value: file.value && withFacts(file.value, factsFile.value) }
      }
      board = merged.value
      readError = file.error && `Could not read the review board: ${file.error}`
      // A comment that left `proposed` or `approved` cannot be posted again, so it stops counting as picked
      for (const c of board ? commentsOf(board) : []) if (!isPickable(c)) picks.delete(c.n)
    } else {
      board = undefined
      readError = undefined
    }
  } catch (err) {
    readError = `Could not read the review board: ${err instanceof Error ? err.message : String(err)}`
  }
  const after = [review?.key, board, readError]
  if (before.some((one, at) => one !== after[at])) $.ui.invalidate('ui.render')
  if (keysOf(reviewPrs()) !== factsKeys || (await $.clock.now()) - factsAt >= FACTS_MS) await reviewFacts($)
}

const reviewPrs = () => (board && Array.isArray(board.prs) ? board.prs : (review?.prs ?? []))
const keysOf = (prs: readonly Pr[]) => prs.map(p => p.pr).join(' ')

async function reviewFacts($: EngineInterface) {
  const prs = reviewPrs()
  factsKeys = keysOf(prs)
  factsAt = await $.clock.now()
  if (prs.length === 0) return
  github = await factsFor($, prs.map(p => trackedOf(p, github)), github.viewer)
  $.ui.invalidate('ui.render')
}

export async function reviewStart($: EngineInterface) {
  home = (await $.env.get('HOME')) ?? ''
  sessionId = await $.session.id()
  workspaceId = await $.env.get('HERDR_WORKSPACE_ID')
  await reviewRefresh($)
  $.clock.every(POLL_MS, () => reviewRefresh($))
}

export async function reviewSync($: EngineInterface) {
  const id = await $.session.id()
  if (id === sessionId) return
  sessionId = id
  await reviewRefresh($)
}

export function reviewView($: EngineInterface): View {
  const choose = (id: string) => update($, stackChoice, () => id)

  return {
    id: 'review',
    title: 'review',
    scope: 'session',
    onShow: () => reviewRefresh($),
    isAvailable: async () => review !== undefined,
    opensAtStart: async () => review !== undefined,
    needs: async () => (board ? commentsOf(board).filter(isPickable).length : 0),
    render: async els => {
      const { Box, Text } = els
      if (!review) {
        const empty = `This session runs no pr-review-board review. Any session can still fill this view by writing a board to ${manualPath}.`

        return (
          <Text dimColor wrap="wrap">
            {readError || empty}
          </Text>
        )
      }
      if (!board) {
        return (
          <Box flexDirection="column">
            <Text bold>{review.slug}</Text>
            <Text dimColor wrap="wrap">
              {readError || `No board yet for ${review.key}.`}
            </Text>
            {prList(els, github, {}, [{ id: 'all', title: 'Stack', prs: review.prs }], false, choose)}
          </Box>
        )
      }
      const b = board
      const now = await $.clock.now()
      const prs = Array.isArray(b.prs) ? b.prs : review.prs
      const comments = commentsOf(b)
      const stacks = stacksOf(b, prs)
      const stacked = stacks.length > 1
      const choice = await read($, stackChoice)
      const stack = stacked ? stacks.find(s => s.id === choice) : undefined
      const inView = stack ? comments.filter(c => stackOf(c, prs, stacks) === stack.id) : comments
      const toDecide = inView.filter(c => c.status !== 'posted' && c.status !== 'dropped')
      const posted = inView.filter(c => c.status === 'posted').sort((x, y) => x.n - y.n)
      const fresh = freshness(b, now, github.checkedAt)
      const children: RenderNode[] = [...(fresh ? [stamp(els, fresh)] : []), header(els, b, review.slug, stack, inView)]
      if (stacked) children.push(stackTabs(els, stacks, stack, choose))
      children.push(prList(els, github, b, stack ? [stack] : stacks, stacked && !stack, choose))
      for (const severity of SEVERITIES) {
        const inSection = toDecide.filter(c => severityOf(c) === severity)
        if (inSection.length > 0) {
          children.push(section(els, severity, inSection.length, inSection.map(c => commentRow($, els, picks, expanded, c, prs))))
        }
      }
      for (const followUp of FOLLOW_UPS) {
        const inSection = posted.filter(followUp.holds)
        if (inSection.length > 0) {
          children.push(section(els, followUp, inSection.length, followUpRows(els, followUp, inSection, prs)))
        }
      }
      // The report covers the whole review, so a stack's view leaves it to All
      if (!stack && Array.isArray(b.report) && b.report.length > 0) children.push(reportBox($, els, expanded, b.report))
      const picking = pickBar($, els, picks, text => {
        notice = text
      })
      if (picking) children.push(picking)
      if (notice) {
        children.push(
          <Text key="notice" color="yellow" wrap="wrap">
            {notice}
          </Text>,
        )
      }

      return (
        <Box key="review" flexDirection="column">
          {children}
        </Box>
      )
    },
  }
}
