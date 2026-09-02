import { existsSync } from 'fs'
import { spawnSync } from 'child_process'

export type AgentRuntime = 'missing' | 'starting' | 'idle' | 'busy' | 'blocked'

export interface MultiplexerPort {
  readonly kind: 'tmux' | 'herdr'
  liveSessions(): Set<string>
  runtime(session: string): AgentRuntime
  prompt(session: string, text: string): boolean
  kill(session: string): boolean
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

export function herdrRuntime(
  status: string,
  foregroundIsAgent: boolean,
  foregroundPromptVisible = false,
): AgentRuntime {
  if (status === 'idle' || status === 'done') return 'idle'
  if (status === 'working') return foregroundPromptVisible ? 'idle' : 'busy'
  if (status === 'blocked') return 'blocked'
  return foregroundIsAgent ? 'starting' : 'missing'
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

  kill(session: string): boolean {
    return spawnSync('tmux', ['kill-session', '-t', `=${session}`], { encoding: 'utf8' }).status === 0
  }
}

type HerdrPane = { paneId: string; status: string }

export class HerdrMux implements MultiplexerPort {
  readonly kind = 'herdr' as const
  private readonly bin = existsSync('/opt/homebrew/bin/herdr') ? '/opt/homebrew/bin/herdr' : 'herdr'

  private panes(): Map<string, HerdrPane> {
    const panes = new Map<string, HerdrPane>()
    const result = spawnSync(this.bin, ['pane', 'list'], { encoding: 'utf8' })
    if (result.status !== 0) return panes
    try {
      const parsed = JSON.parse(result.stdout ?? '{}')
      for (const pane of parsed?.result?.panes ?? []) {
        if (pane?.label) {
          panes.set(String(pane.label), {
            paneId: String(pane.pane_id ?? ''),
            status: String(pane.agent_status ?? 'unknown'),
          })
        }
      }
    } catch {}
    return panes
  }

  private foregroundIsAgent(paneId: string): boolean {
    const result = spawnSync(this.bin, ['pane', 'process-info', '--pane', paneId], { encoding: 'utf8' })
    if (result.status !== 0) return false
    try {
      const processes = JSON.parse(result.stdout ?? '{}')?.result?.process_info?.foreground_processes ?? []
      return processes.some((process: any) =>
        !/^(zsh|bash|sh|fish|dash|ksh)$/.test(String(process?.name ?? '')),
      )
    } catch {
      return false
    }
  }

  private foregroundPromptVisible(paneId: string): boolean {
    const result = spawnSync(this.bin, ['pane', 'read', paneId, '--source', 'visible'], { encoding: 'utf8' })
    return result.status === 0 && claudePromptVisible(result.stdout ?? '')
  }

  liveSessions(): Set<string> {
    const sessions = new Set<string>()
    for (const [label, pane] of this.panes()) {
      if (herdrRuntime(pane.status, this.foregroundIsAgent(pane.paneId)) !== 'missing') sessions.add(label)
    }
    return sessions
  }

  runtime(session: string): AgentRuntime {
    const pane = this.panes().get(session)
    if (!pane) return 'missing'
    const promptVisible = pane.status === 'working' && this.foregroundPromptVisible(pane.paneId)
    return herdrRuntime(pane.status, this.foregroundIsAgent(pane.paneId), promptVisible)
  }

  prompt(session: string, text: string): boolean {
    const pane = this.panes().get(session)
    if (!pane) return false
    const promptVisible = pane.status === 'working' && this.foregroundPromptVisible(pane.paneId)
    if (herdrRuntime(pane.status, this.foregroundIsAgent(pane.paneId), promptVisible) !== 'idle') return false
    const args = promptVisible
      ? ['pane', 'run', pane.paneId, text]
      : ['agent', 'prompt', pane.paneId, text]
    return spawnSync(this.bin, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).status === 0
  }

  kill(session: string): boolean {
    const paneId = this.panes().get(session)?.paneId
    if (!paneId) return false
    return spawnSync(this.bin, ['pane', 'close', paneId], { encoding: 'utf8' }).status === 0
  }
}

export function createMultiplexer(kind: 'tmux' | 'herdr'): MultiplexerPort {
  return kind === 'herdr' ? new HerdrMux() : new TmuxMux()
}
