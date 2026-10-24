export type BoardSection =
  | 'next'
  | 'questions'
  | 'decisions'
  | 'links'
  | 'ideas'
  | 'topics'

export type BoardItem = {
  id: string
  section: BoardSection
  text: string
  url?: string
  isDone?: boolean
}

export type Board = {
  sessionId: string
  goal: string
  summary: string
  items: BoardItem[]
  seq: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': { board: Shaped<Board>; isDismissed: boolean }
  }
}
