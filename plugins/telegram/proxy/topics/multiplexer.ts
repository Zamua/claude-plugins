import { spawnSync } from 'child_process'
import { herdrAgentStatus, parseHerdrPanes } from '../shared/herdr-panes'
import type { AgentRuntime, HerdrPane } from '../shared/herdr-panes'

export type { AgentRuntime }

export interface MultiplexerPort {
  readonly kind: 'tmux' | 'herdr' | 'hc'
  liveSessions(): Set<string>
  runtime(session: string): AgentRuntime
  prompt(session: string, text: string): boolean
  /** Presses the agent's stop key (Escape), ending its current turn; false when the session is not there. */
  interrupt(session: string): boolean
  kill(session: string): boolean
  /**
   * The pid of the session's agent as the multiplexer sees it (the process
   * holding the terminal), from which every process the agent starts descends;
   * undefined when it cannot say.
   */
  agentPid(session: string): number | undefined
}

export function claudePromptVisible(visible: string): boolean {
  const lines = visible.split(/\r?\n/)
  // Claude keeps accepting queued user turns while background work runs. Once
  // one turn is queued, the otherwise blank prompt grows this helper label;
  // it is still an input surface, not active output.
  const prompt = lines.findLastIndex(line =>
    /^\s*❯(?:\s+Press up to edit queued messages)?\s*$/.test(line))
  if (prompt < 0) return false
  return lines.slice(prompt + 1).some(line => /^\s*Claude\s+·/.test(line))
}

export class TmuxMux implements MultiplexerPort {
  readonly kind = 'tmux' as const

  liveSessions(): Set<string> {
    const result = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' })
    if (result.status !== 0) return new Set()
    return new Set(
      (result.stdout ?? '')
        .split('\n')
        .map(value => value.trim())
        .filter(Boolean),
    )
  }

  runtime(session: string): AgentRuntime {
    if (!this.liveSessions().has(session)) return 'missing'
    const result = spawnSync('tmux', ['capture-pane', '-t', session, '-p'], { encoding: 'utf8' })
    if (result.status !== 0) return 'starting'
    const visible = result.stdout ?? ''
    return /(?:^|\n)\s*❯\s*(?:\n|$)/.test(visible) ? 'idle' : 'busy'
  }

  prompt(session: string, text: string): boolean {
    if (this.runtime(session) !== 'idle') return false
    const buffer = `telegram-inbound-${process.pid}`
    const loaded = spawnSync('tmux', ['load-buffer', '-b', buffer, '-'], {
      encoding: 'utf8',
      input: text,
    })
    if (loaded.status !== 0) return false
    const pasted = spawnSync('tmux', ['paste-buffer', '-d', '-b', buffer, '-t', session], { encoding: 'utf8' })
    if (pasted.status !== 0) return false
    return spawnSync('tmux', ['send-keys', '-t', session, 'Enter'], { encoding: 'utf8' }).status === 0
  }

  interrupt(session: string): boolean {
    if (!this.liveSessions().has(session)) return false
    return spawnSync('tmux', ['send-keys', '-t', session, 'Escape'], { encoding: 'utf8' }).status === 0
  }

  kill(session: string): boolean {
    return spawnSync('tmux', ['kill-session', '-t', `=${session}`], { encoding: 'utf8' }).status === 0
  }

  agentPid(session: string): number | undefined {
    const result = spawnSync('tmux', ['display-message', '-p', '-t', session, '#{pane_pid}'], { encoding: 'utf8' })
    const pid = Number((result.stdout ?? '').trim())
    return result.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined
  }
}

export class HerdrMux implements MultiplexerPort {
  readonly kind = 'herdr' as const
  constructor(private readonly bin: string) {}

  private panes(): Map<string, HerdrPane> {
    const result = spawnSync(this.bin, ['pane', 'list'], { encoding: 'utf8' })
    return result.status === 0 ? parseHerdrPanes(result.stdout ?? '') : new Map()
  }

  private processInfo(paneId: string): HerdrProcessInfo | undefined {
    const result = spawnSync(this.bin, ['pane', 'process-info', '--pane', paneId], { encoding: 'utf8' })
    return result.status === 0 ? parseHerdrProcessInfo(result.stdout ?? '') : undefined
  }

  private foregroundIsAgent(paneId: string): boolean {
    return (this.processInfo(paneId)?.foreground_processes ?? []).some(process =>
      !/^(zsh|bash|sh|fish|dash|ksh)$/.test(String(process?.name ?? '')),
    )
  }

  private foregroundPromptVisible(paneId: string): boolean {
    const result = spawnSync(this.bin, ['pane', 'read', paneId, '--source', 'visible'], { encoding: 'utf8' })
    return result.status === 0 && claudePromptVisible(result.stdout ?? '')
  }

  liveSessions(): Set<string> {
    const sessions = new Set<string>()
    for (const [label, pane] of this.panes()) {
      if (herdrAgentStatus(pane.status, this.foregroundIsAgent(pane.paneId)) !== 'missing') sessions.add(label)
    }
    return sessions
  }

  runtime(session: string): AgentRuntime {
    const pane = this.panes().get(session)
    if (!pane) return 'missing'
    const promptVisible = pane.status === 'working' && this.foregroundPromptVisible(pane.paneId)
    return herdrAgentStatus(pane.status, this.foregroundIsAgent(pane.paneId), promptVisible)
  }

  prompt(session: string, text: string): boolean {
    const pane = this.panes().get(session)
    if (!pane) return false
    const promptVisible = pane.status === 'working' && this.foregroundPromptVisible(pane.paneId)
    if (herdrAgentStatus(pane.status, this.foregroundIsAgent(pane.paneId), promptVisible) !== 'idle') return false
    const args = promptVisible
      ? ['pane', 'run', pane.paneId, text]
      : ['agent', 'prompt', pane.paneId, text]
    return spawnSync(this.bin, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).status === 0
  }

  interrupt(session: string): boolean {
    const paneId = this.panes().get(session)?.paneId
    if (!paneId) return false
    return spawnSync(this.bin, ['pane', 'send-keys', paneId, 'esc'], { encoding: 'utf8' }).status === 0
  }

  kill(session: string): boolean {
    const paneId = this.panes().get(session)?.paneId
    if (!paneId) return false
    return spawnSync(this.bin, ['pane', 'close', paneId], { encoding: 'utf8' }).status === 0
  }

  /** The pane's foreground process group: the agent leads it while it holds the terminal. */
  agentPid(session: string): number | undefined {
    const paneId = this.panes().get(session)?.paneId
    const group = paneId ? this.processInfo(paneId)?.foreground_process_group_id : undefined
    return Number.isInteger(group) && (group as number) > 0 ? group : undefined
  }
}

type HerdrProcessInfo = { foreground_process_group_id?: number; foreground_processes?: Array<{ name?: unknown }> }

export function parseHerdrProcessInfo(output: string): HerdrProcessInfo | undefined {
  try {
    const info = JSON.parse(output)?.result?.process_info
    return info && typeof info === 'object' ? info : undefined
  } catch {
    return undefined
  }
}

export function createMultiplexer(kind: 'tmux' | 'herdr', herdrBin: string): MultiplexerPort {
  return kind === 'herdr' ? new HerdrMux(herdrBin) : new TmuxMux()
}
