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
}

declare module 'claude-code' {
  interface PluginState {
    'my-pr-board': { board: Shaped<PrBoard>; isDismissed: boolean }
  }
}
