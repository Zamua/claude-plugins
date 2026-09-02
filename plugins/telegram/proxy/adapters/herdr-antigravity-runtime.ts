import { existsSync } from 'fs'
import type {
  AntigravityRuntimePort,
  AntigravitySessionSpec,
  AntigravitySessionStatus,
} from '../application/antigravity-ports'
import { AntigravityCli } from './antigravity-cli'
import { nodeProcessRunner } from './process-runner'
import type { ProcessRunner } from './process-runner'

export type AntigravityPane = { paneId: string; status: string }

export function antigravityInteractiveArgs(input: {
  modelVariant: string
  effort: string
  conversationId?: string
  kickoff: string
}): string[] {
  return [
    '--model', input.modelVariant,
    '--effort', input.effort,
    '--dangerously-skip-permissions',
    ...(input.conversationId
      ? ['--conversation', input.conversationId]
      : ['--prompt-interactive', input.kickoff]),
  ]
}

export function findAntigravityPane(output: string, sessionName: string): AntigravityPane | undefined {
  try {
    const panes = JSON.parse(output)?.result?.panes ?? []
    const pane = panes.find((candidate: any) => candidate?.label === sessionName)
    if (!pane?.pane_id) return undefined
    return { paneId: String(pane.pane_id), status: String(pane.agent_status ?? 'unknown') }
  } catch {
    return undefined
  }
}

export function antigravityHerdrStatus(
  pane: AntigravityPane | undefined,
  foregroundIsAgy: boolean,
): AntigravitySessionStatus {
  if (!pane) return 'missing'
  if (pane.status === 'idle' || pane.status === 'done') return 'idle'
  if (pane.status === 'working') return 'busy'
  if (pane.status === 'blocked') return 'blocked'
  return foregroundIsAgy ? 'starting' : 'missing'
}

export function parseAntigravityConversationId(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\/conversations\/([0-9a-f-]{36})\.db$/i)
    if (match) return match[1]
  }
  return undefined
}

export function parseHerdrPromptResult(output: string): string | undefined {
  try {
    const type = JSON.parse(output)?.result?.type
    return typeof type === 'string' ? type : undefined
  } catch {
    return undefined
  }
}

export function parseAntigravityConversationArgument(output: string): string | undefined {
  try {
    const processes = JSON.parse(output)?.result?.process_info?.foreground_processes ?? []
    const argv = processes.find((process: any) => String(process?.name ?? '') === 'agy')?.argv
    if (!Array.isArray(argv)) return undefined
    const index = argv.indexOf('--conversation')
    if (index >= 0 && typeof argv[index + 1] === 'string') return argv[index + 1]
    const inline = argv.find((argument: unknown) =>
      typeof argument === 'string' && argument.startsWith('--conversation='))
    return typeof inline === 'string' ? inline.slice('--conversation='.length) : undefined
  } catch {
    return undefined
  }
}

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export class HerdrAntigravityRuntime implements AntigravityRuntimePort {
  private readonly catalog: AntigravityCli

  constructor(
    private readonly antigravityBinary: string,
    private readonly cwd: string,
    private readonly launcher: string,
    private readonly proxyUrl: string,
    private readonly herdrBinary = existsSync('/opt/homebrew/bin/herdr')
      ? '/opt/homebrew/bin/herdr'
      : 'herdr',
    private readonly run: ProcessRunner = nodeProcessRunner,
    private readonly pause: (milliseconds: number) => Promise<unknown> = wait,
  ) {
    this.catalog = new AntigravityCli(antigravityBinary, cwd, run)
  }

  models() {
    return this.catalog.models()
  }

  usage() {
    return this.catalog.usage()
  }

  async status(sessionName: string): Promise<AntigravitySessionStatus> {
    const pane = await this.pane(sessionName)
    if (!pane) return 'missing'
    const foreground = pane.status === 'unknown' ? await this.foregroundAgy(pane.paneId) : true
    return antigravityHerdrStatus(pane, foreground)
  }

  async ensureSession(input: AntigravitySessionSpec) {
    let pane = await this.pane(input.sessionName)
    let launched = false
    if (pane) {
      const state = await this.status(input.sessionName)
      if (state === 'missing') {
        await this.run(this.herdrBinary, ['pane', 'close', pane.paneId], {
          cwd: this.cwd, timeout: 30_000,
        }).catch(() => undefined)
        pane = undefined
      }
    }

    if (!pane) {
      const args = antigravityInteractiveArgs({
        modelVariant: input.route.modelVariant,
        effort: input.route.effort,
        conversationId: input.conversationId,
        kickoff: input.kickoff,
      })
      await this.run(this.launcher, [], {
        cwd: this.cwd,
        timeout: 30_000,
        env: {
          ...process.env,
          AG_SESSION: input.sessionName,
          AG_SPAWN_DIR: this.cwd,
          AG_BIN: this.antigravityBinary,
          AG_ARGS_JSON: JSON.stringify(args),
          TELEGRAM_TOPIC_ID: input.topic,
          TELEGRAM_PROXY_URL: this.proxyUrl,
        },
      })
      launched = true
    }

    // Conversation discovery is a creation-time concern. Antigravity closes
    // its SQLite conversation file once an interactive session has been idle,
    // so re-running lsof before every Telegram turn can never prove identity
    // and instead stalls each message until the discovery timeout. The topic
    // aggregate already owns the captured id. A resumed process also exposes
    // that id explicitly in argv, which gives us an additional fork check.
    if (pane && input.conversationId) {
      const commanded = await this.commandConversationId(pane.paneId)
      if (commanded && commanded !== input.conversationId) {
        await this.stop(input.sessionName).catch(() => false)
        throw new Error(
          `Herdr Antigravity pane ${input.sessionName} resumed ${commanded}, ` +
          `expected ${input.conversationId}`,
        )
      }
      return { sessionName: input.sessionName, conversationId: input.conversationId }
    }

    const identity = await this.waitForIdentity(input.sessionName, 180_000)
    if (input.conversationId && identity !== input.conversationId) {
      // Never leave a same-labelled fork running after discovering that Herdr
      // opened the wrong conversation. The application service cannot clean it
      // up because ensureSession has not returned the pane identity yet.
      await this.stop(input.sessionName).catch(() => false)
      throw new Error(
        `Herdr Antigravity pane ${input.sessionName} opened ${identity}, expected ${input.conversationId}`,
      )
    }
    // Herdr can report the first post-kickoff idle state a fraction before the
    // TUI accepts another bracketed-paste prompt. Without a short cold-start
    // grace, `agent prompt` can return agent_prompt_stalled and drop the first
    // Telegram turn even though the pane looks idle.
    if (launched) await this.pause(2_000)
    return { sessionName: input.sessionName, conversationId: identity }
  }

  async prompt(sessionName: string, prompt: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pane = await this.waitUntilIdle(sessionName, 31 * 60_000)
      const result = await this.run(
        this.herdrBinary,
        ['agent', 'prompt', pane.paneId, prompt, '--wait', '--timeout', String(31 * 60_000)],
        { cwd: this.cwd, timeout: 31 * 60_000 + 10_000 },
      )
      const outcome = parseHerdrPromptResult(result.stdout)
      if (outcome === 'agent_prompted') return
      if (outcome !== 'agent_prompt_stalled') {
        throw new Error(
          `Herdr did not accept the Antigravity prompt (result: ${outcome ?? 'unrecognized'})`,
        )
      }
      // Herdr reports a readiness race as structured JSON with exit code zero.
      // Treating that as success silently loses the Telegram turn. Re-check the
      // pane and retry only this explicit not-delivered outcome.
      if (attempt < 3) await this.pause(1_000)
    }
    throw new Error('Herdr could not deliver the Antigravity prompt after 3 readiness retries')
  }

  async stop(sessionName: string): Promise<boolean> {
    const pane = await this.pane(sessionName)
    if (!pane) return false
    await this.run(this.herdrBinary, ['pane', 'close', pane.paneId], {
      cwd: this.cwd, timeout: 30_000,
    })
    return true
  }

  private async pane(sessionName: string): Promise<AntigravityPane | undefined> {
    const result = await this.run(this.herdrBinary, ['pane', 'list'], {
      cwd: this.cwd, timeout: 30_000,
    })
    return findAntigravityPane(result.stdout, sessionName)
  }

  private async foregroundAgy(paneId: string): Promise<boolean> {
    const result = await this.run(
      this.herdrBinary,
      ['pane', 'process-info', '--pane', paneId],
      { cwd: this.cwd, timeout: 30_000 },
    ).catch(() => undefined)
    if (!result) return false
    try {
      const processes = JSON.parse(result.stdout)?.result?.process_info?.foreground_processes ?? []
      return processes.some((process: any) => String(process?.name ?? '') === 'agy')
    } catch {
      return false
    }
  }

  private async waitForIdentity(sessionName: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let lastState: AntigravitySessionStatus = 'starting'
    while (Date.now() < deadline) {
      const pane = await this.pane(sessionName)
      if (pane) {
        lastState = await this.status(sessionName)
        if (lastState === 'blocked') throw new Error(`Antigravity pane ${sessionName} is blocked`)
        const identity = await this.conversationId(pane.paneId)
        if (identity && lastState === 'idle') return identity
      }
      await this.pause(250)
    }
    throw new Error(`Antigravity pane ${sessionName} did not become ready (last state: ${lastState})`)
  }

  private async waitUntilIdle(sessionName: string, timeoutMs: number): Promise<AntigravityPane> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pane = await this.pane(sessionName)
      if (!pane) throw new Error(`Antigravity pane ${sessionName} is not running`)
      const state = await this.status(sessionName)
      if (state === 'idle') return pane
      if (state === 'blocked') throw new Error(`Antigravity pane ${sessionName} is blocked`)
      await this.pause(500)
    }
    throw new Error(`Antigravity pane ${sessionName} stayed busy for ${timeoutMs}ms`)
  }

  private async conversationId(paneId: string): Promise<string | undefined> {
    const info = await this.run(
      this.herdrBinary,
      ['pane', 'process-info', '--pane', paneId],
      { cwd: this.cwd, timeout: 30_000 },
    ).catch(() => undefined)
    if (!info) return undefined
    let processes: any[] = []
    try {
      processes = JSON.parse(info.stdout)?.result?.process_info?.foreground_processes ?? []
    } catch {
      return undefined
    }
    const pid = processes.find(process => String(process?.name ?? '') === 'agy')?.pid
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    const openFiles = await this.run('/usr/sbin/lsof', ['-Fn', '-p', String(pid)], {
      cwd: this.cwd, timeout: 10_000,
    }).catch(() => undefined)
    return openFiles ? parseAntigravityConversationId(openFiles.stdout) : undefined
  }

  private async commandConversationId(paneId: string): Promise<string | undefined> {
    const info = await this.run(
      this.herdrBinary,
      ['pane', 'process-info', '--pane', paneId],
      { cwd: this.cwd, timeout: 30_000 },
    ).catch(() => undefined)
    return info ? parseAntigravityConversationArgument(info.stdout) : undefined
  }
}
