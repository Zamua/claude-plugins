export type OpencodeSessionIdentity = {
  sessionName: string
  opencodeSessionId: string
}

export type OpencodeSessionSpec = {
  topic: string
  name: string
  sessionName: string
  opencodeSessionId?: string
  kickoff: string
}

export type OpencodeSessionStatus = 'missing' | 'starting' | 'idle' | 'busy' | 'blocked'

export interface OpencodeRuntimePort {
  status(sessionName: string): Promise<OpencodeSessionStatus>
  ensureSession(input: OpencodeSessionSpec): Promise<OpencodeSessionIdentity>
  prompt(sessionName: string, prompt: string): Promise<void>
  stop(sessionName: string): Promise<boolean>
  lastAssistantText(opencodeSessionId: string): Promise<OpencodeAssistantText | undefined>
}

export type OpencodeAssistantText = { text: string; finish?: string }

export interface OpencodeOutboundPort {
  typing(topic: string): void
  error(topic: string, text: string): Promise<void>
  repliedSince(topic: string, sinceMs: number): boolean
  // Proxy-relayed text in the thread, distinct from the agent's own reply.
  notice(topic: string, text: string): Promise<void>
}
