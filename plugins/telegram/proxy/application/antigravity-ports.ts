import type { AntigravityEffort, AntigravityModel } from '../domain/antigravity-topic'

export type AntigravityUsageWindow = {
  pool: string
  window: string
  remainingPercent: number
  resetsAt: number
}

export type AntigravitySessionIdentity = {
  sessionName: string
  conversationId: string
}

export type AntigravitySessionSpec = {
  topic: string
  name: string
  sessionName: string
  route: {
    modelVariant: string
    effort: AntigravityEffort
  }
  conversationId?: string
  kickoff: string
}

export type AntigravitySessionStatus = 'missing' | 'starting' | 'idle' | 'busy' | 'blocked'

export interface AntigravityCatalogPort {
  models(): Promise<AntigravityModel[]>
  usage(): Promise<AntigravityUsageWindow[]>
}

export interface AntigravitySessionPort {
  status(sessionName: string): Promise<AntigravitySessionStatus>
  ensureSession(input: AntigravitySessionSpec): Promise<AntigravitySessionIdentity>
  prompt(sessionName: string, prompt: string): Promise<void>
  stop(sessionName: string): Promise<boolean>
}

export interface AntigravityRuntimePort extends AntigravityCatalogPort, AntigravitySessionPort {}

export interface AntigravityOutboundPort {
  typing(topic: string): void
  error(topic: string, text: string): Promise<void>
}
