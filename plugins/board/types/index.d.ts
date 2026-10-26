export type SessionSection =
  | 'next'
  | 'questions'
  | 'decisions'
  | 'links'
  | 'ideas'
  | 'topics'

export type SessionItem = {
  id: string
  section: SessionSection
  text: string
  url?: string
  isDone?: boolean
}

export type SessionBoard = {
  sessionId: string
  goal: string
  summary: string
  items: SessionItem[]
  seq: number
  /** The session-board plugin's board for this session was taken in, or it had none. */
  legacyImported?: boolean
}

export type CiState = 'pass' | 'fail' | 'pending' | 'none'

export type PrFacts = {
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  mergeable: string
  mergeState: string
  review: string
  approvedBy: string[]
  changesRequestedBy: string[]
  ci: CiState
  failing: string[]
  author: string
  head: string
  base: string
  headSha: string
  waiting: number
  waitingUrl?: string
}

export type TrackedPr = {
  key: string
  owner: string
  repo: string
  number: number
  url: string
  note: string
  stack: string
  facts?: PrFacts
  error?: string
}

export type PrBoard = {
  sessionId: string
  prs: TrackedPr[]
  viewer: string
  checkedAt: number
  error: string
  /** The my-pr-board plugin's board for this session was taken in, or it had none. */
  legacyImported?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    board: {
      sessionId: string
      selected: string
      isDismissed: boolean
      reviewStack: string
      session: Shaped<SessionBoard>
      prs: Shaped<PrBoard>
    }
  }
}
