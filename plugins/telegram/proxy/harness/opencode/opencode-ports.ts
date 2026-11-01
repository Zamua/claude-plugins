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
  // Types the text into the pane and submits it; returns as soon as it is
  // sent. OpenCode queues a prompt typed while a turn runs.
  inject(sessionName: string, text: string): Promise<void>
  // Resolves once the pane has been idle for the settle window; rejects on a
  // blocked pane or the timeout.
  awaitSettled(sessionName: string, timeoutMs: number): Promise<void>
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
