import type { AntigravityEffort, AntigravityModel } from '../domain/antigravity-topic'

export type AntigravityUsageWindow = {
  pool: string
  window: string
  remainingPercent: number
  resetsAt: number
}

export type AntigravityTurnResult = {
  conversationId: string
  response: string
  status: string
}

export type AntigravityTurn = {
  prompt: string
  modelVariant: string
  effort: AntigravityEffort
  conversationId?: string
}

export interface AntigravityRuntimePort {
  models(): Promise<AntigravityModel[]>
  usage(): Promise<AntigravityUsageWindow[]>
  turn(input: AntigravityTurn): Promise<AntigravityTurnResult>
}

export interface AntigravityOutboundPort {
  typing(topic: string): void
  reply(topic: string, text: string): Promise<void>
  error(topic: string, text: string): Promise<void>
}
