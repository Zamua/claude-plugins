import { existsSync } from 'fs'
import type {
  OpencodeAssistantText,
  OpencodeRuntimePort,
  OpencodeSessionSpec,
  OpencodeSessionStatus,
} from '../application/opencode-ports'
import { parseHerdrPromptResult } from './herdr-antigravity-runtime'
import { nodeProcessRunner } from './process-runner'
import type { ProcessRunner } from './process-runner'

export { parseHerdrPromptResult }

export type OpencodePane = { paneId: string; status: string }

// Clock skew between the launcher and OpenCode's session timestamps.
const SESSION_CREATED_SLACK_MS = 5_000
// Herdr flickers idle between OpenCode tool calls, and a prompt injected then
// aborts the running turn. A turn counts as settled only after this much
// continuous idle.
export const OPENCODE_SETTLE_MS = 6_000
const SETTLE_POLL_MS = 1_000
export const DEFAULT_OPENCODE_MODEL = 'qwen-local/Qwen3.8-27B'

export function opencodeInteractiveArgs(input: {
  projectDir: string
  model: string
  opencodeSessionId?: string
  kickoff: string
}): string[] {
  return [
    input.projectDir,
    '-m', input.model,
    // External TUI plugins (a vim-mode plugin in particular) swallow injected text as commands.
    '--pure',
    ...(input.opencodeSessionId
      ? ['-s', input.opencodeSessionId]
      : ['--prompt', input.kickoff]),
  ]
}

export function opencodeMcpConfigContent(bunPath: string, serverFile: string): string {
  return JSON.stringify({
    mcp: {
      'telegram-topics': { type: 'local', command: [bunPath, serverFile], enabled: true },
    },
  })
}

export function findOpencodePane(output: string, sessionName: string): OpencodePane | undefined {
  try {
    const panes = JSON.parse(output)?.result?.panes ?? []
    const pane = panes.find((candidate: any) => candidate?.label === sessionName)
    if (!pane?.pane_id) return undefined
    return { paneId: String(pane.pane_id), status: String(pane.agent_status ?? 'unknown') }
  } catch {
    return undefined
  }
}

export function opencodeHerdrStatus(
  pane: OpencodePane | undefined,
  foregroundIsOpencode: boolean,
): OpencodeSessionStatus {
  if (!pane) return 'missing'
  if (pane.status === 'idle' || pane.status === 'done') return 'idle'
  if (pane.status === 'working') return 'busy'
  if (pane.status === 'blocked') return 'blocked'
  return foregroundIsOpencode ? 'starting' : 'missing'
}

// `opencode session list --format json` is scoped to its cwd, which the
// operator's own manual sessions share. Only sessions created inside the
// launch window can belong to this launch; more than one means the identity
// is ambiguous and must not be guessed.
export function parseOpencodeSessionList(
  output: string,
  notBeforeMs: number,
  nowMs: number,
): string[] {
  try {
    const sessions = JSON.parse(output)
    if (!Array.isArray(sessions)) return []
    return sessions
      .filter((session: any) => {
        if (typeof session?.id !== 'string' || !session.id) return false
        const created = Number(session.created)
        return Number.isFinite(created) && created >= notBeforeMs && created <= nowMs
      })
      .map((session: any) => session.id as string)
  } catch {
    return []
  }
}

export function parseOpencodeSessionArgument(output: string): string | undefined {
  try {
    const processes = JSON.parse(output)?.result?.process_info?.foreground_processes ?? []
    const argv = processes.find((process: any) => String(process?.name ?? '') === 'opencode')?.argv
    if (!Array.isArray(argv)) return undefined
    for (const flag of ['-s', '--session']) {
      const index = argv.indexOf(flag)
      if (index >= 0 && typeof argv[index + 1] === 'string') return argv[index + 1]
    }
    const inline = argv.find((argument: unknown) =>
      typeof argument === 'string' && argument.startsWith('--session='))
    return typeof inline === 'string' ? inline.slice('--session='.length) : undefined
  } catch {
    return undefined
  }
}

// `opencode export` output: the last assistant message's text parts and finish
// reason. Reasoning and tool parts are not user-facing.
export function parseOpencodeExport(output: string): OpencodeAssistantText | undefined {
  try {
    const messages = JSON.parse(output)?.messages
    if (!Array.isArray(messages)) return undefined
    const last = [...messages].reverse().find((message: any) => message?.info?.role === 'assistant')
    if (!last) return undefined
    const parts = Array.isArray(last.parts) ? last.parts : []
    const text = parts
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text as string)
      .join('\n')
      .trim()
    const finish = typeof last.info.finish === 'string' ? last.info.finish : undefined
    return finish === undefined ? { text } : { text, finish }
  } catch {
    return undefined
  }
}

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export class HerdrOpencodeRuntime implements OpencodeRuntimePort {
  constructor(
    private readonly opencodeBinary: string,
    private readonly projectDir: string,
    private readonly launcher: string,
    private readonly proxyUrl: string,
    private readonly bunPath: string,
    private readonly serverFile: string,
    private readonly herdrBinary = existsSync('/opt/homebrew/bin/herdr')
      ? '/opt/homebrew/bin/herdr'
      : 'herdr',
    private readonly run: ProcessRunner = nodeProcessRunner,
    private readonly pause: (milliseconds: number) => Promise<unknown> = wait,
    // The spec carries no model: a localcode topic is single-model by design.
    private readonly model = process.env.TELEGRAM_OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL,
  ) {}

  async status(sessionName: string): Promise<OpencodeSessionStatus> {
    const pane = await this.pane(sessionName)
    return pane ? this.paneStatus(pane) : 'missing'
  }

  async lastAssistantText(opencodeSessionId: string): Promise<OpencodeAssistantText | undefined> {
    const result = await this.run(
      this.opencodeBinary,
      ['export', opencodeSessionId],
      { cwd: this.projectDir, timeout: 30_000 },
    ).catch(() => undefined)
    return result ? parseOpencodeExport(result.stdout) : undefined
  }

  async ensureSession(input: OpencodeSessionSpec) {
    const pane = await this.pane(input.sessionName)
    if (pane) {
      const state = await this.status(input.sessionName)
      const commanded = state === 'missing' ? undefined : await this.commandSessionId(pane.paneId)
      if (input.opencodeSessionId) {
        if (state !== 'missing') {
          if (commanded && commanded !== input.opencodeSessionId) {
            await this.stop(input.sessionName).catch(() => false)
            throw new Error(
              `Herdr OpenCode pane ${input.sessionName} resumed ${commanded}, ` +
              `expected ${input.opencodeSessionId}`,
            )
          }
          return { sessionName: input.sessionName, opencodeSessionId: input.opencodeSessionId }
        }
      } else if (commanded) {
        return { sessionName: input.sessionName, opencodeSessionId: commanded }
      }
      // Identity is only ever captured from a launch this adapter started. A
      // live pane with no persisted id and no `-s` in argv could be anything,
      // including a session the operator opened by hand in the same project
      // dir, so it is closed rather than inspected.
      await this.run(this.herdrBinary, ['pane', 'close', pane.paneId], {
        cwd: this.projectDir, timeout: 30_000,
      }).catch(() => undefined)
    }

    const args = opencodeInteractiveArgs({
      projectDir: this.projectDir,
      model: this.model,
      opencodeSessionId: input.opencodeSessionId,
      kickoff: input.kickoff,
    })
    const launchStartedAt = Date.now()
    await this.run(this.launcher, [], {
      cwd: this.projectDir,
      timeout: 30_000,
      env: {
        ...process.env,
        OC_SESSION: input.sessionName,
        OC_SPAWN_DIR: this.projectDir,
        OC_BIN: this.opencodeBinary,
        OC_ARGS_JSON: JSON.stringify(args),
        OC_CONFIG_CONTENT: opencodeMcpConfigContent(this.bunPath, this.serverFile),
        TELEGRAM_TOPIC_ID: input.topic,
        TELEGRAM_PROXY_URL: this.proxyUrl,
      },
    })

    if (input.opencodeSessionId) {
      // A relaunch reopens an old session whose creation time predates this
      // launch, so the creation-gated listing can never confirm it. The argv
      // the process was started with can.
      const resumed = await this.waitUntilIdle(input.sessionName, 180_000)
      const commanded = await this.commandSessionId(resumed.paneId)
      if (commanded && commanded !== input.opencodeSessionId) {
        await this.stop(input.sessionName).catch(() => false)
        throw new Error(
          `Herdr OpenCode pane ${input.sessionName} resumed ${commanded}, expected ${input.opencodeSessionId}`,
        )
      }
      await this.pause(2_000)
      return { sessionName: input.sessionName, opencodeSessionId: input.opencodeSessionId }
    }

    const identity = await this.waitForIdentity(
      input.sessionName, launchStartedAt - SESSION_CREATED_SLACK_MS, 180_000,
    )
    // Herdr can report the first post-kickoff idle state a fraction before the
    // TUI accepts another prompt. Without a short cold-start grace, `agent
    // prompt` can stall and drop the first Telegram turn.
    await this.pause(2_000)
    return { sessionName: input.sessionName, opencodeSessionId: identity }
  }

  async prompt(sessionName: string, prompt: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pane = await this.waitUntilIdle(sessionName, 31 * 60_000)
      const result = await this.run(
        this.herdrBinary,
        ['agent', 'prompt', pane.paneId, prompt, '--wait', '--timeout', String(31 * 60_000)],
        { cwd: this.projectDir, timeout: 31 * 60_000 + 10_000 },
      )
      const outcome = parseHerdrPromptResult(result.stdout)
      if (outcome === 'agent_prompted') {
        // `--wait` returns on the first idle report, which can be mid-turn.
        await this.waitUntilIdle(sessionName, 31 * 60_000)
        return
      }
      if (outcome !== 'agent_prompt_stalled') {
        throw new Error(
          `Herdr did not accept the OpenCode prompt (result: ${outcome ?? 'unrecognized'})`,
        )
      }
      // Herdr reports a readiness race as structured JSON with exit code zero.
      // Treating that as success silently loses the Telegram turn.
      if (attempt < 3) await this.pause(1_000)
    }
    throw new Error('Herdr could not deliver the OpenCode prompt after 3 readiness retries')
  }

  async stop(sessionName: string): Promise<boolean> {
    const pane = await this.pane(sessionName)
    if (!pane) return false
    await this.run(this.herdrBinary, ['pane', 'close', pane.paneId], {
      cwd: this.projectDir, timeout: 30_000,
    })
    return true
  }

  private async pane(sessionName: string): Promise<OpencodePane | undefined> {
    const result = await this.run(this.herdrBinary, ['pane', 'list'], {
      cwd: this.projectDir, timeout: 30_000,
    })
    return findOpencodePane(result.stdout, sessionName)
  }

  private async paneStatus(pane: OpencodePane): Promise<OpencodeSessionStatus> {
    const foreground = pane.status === 'unknown' ? await this.foregroundOpencode(pane.paneId) : true
    return opencodeHerdrStatus(pane, foreground)
  }

  private async processInfo(paneId: string): Promise<string | undefined> {
    const result = await this.run(
      this.herdrBinary,
      ['pane', 'process-info', '--pane', paneId],
      { cwd: this.projectDir, timeout: 30_000 },
    ).catch(() => undefined)
    return result?.stdout
  }

  private async foregroundOpencode(paneId: string): Promise<boolean> {
    const output = await this.processInfo(paneId)
    if (!output) return false
    try {
      const processes = JSON.parse(output)?.result?.process_info?.foreground_processes ?? []
      return processes.some((process: any) => String(process?.name ?? '') === 'opencode')
    } catch {
      return false
    }
  }

  private async commandSessionId(paneId: string): Promise<string | undefined> {
    const output = await this.processInfo(paneId)
    return output ? parseOpencodeSessionArgument(output) : undefined
  }

  private async sessionsCreatedSince(notBeforeMs: number): Promise<string[]> {
    const result = await this.run(
      this.opencodeBinary,
      ['session', 'list', '--format', 'json', '-n', '20'],
      { cwd: this.projectDir, timeout: 30_000 },
    ).catch(() => undefined)
    return result ? parseOpencodeSessionList(result.stdout, notBeforeMs, Date.now()) : []
  }

  private async waitForIdentity(
    sessionName: string,
    notBeforeMs: number,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let lastState: OpencodeSessionStatus = 'starting'
    while (Date.now() < deadline) {
      const pane = await this.pane(sessionName)
      if (pane) {
        lastState = await this.paneStatus(pane)
        if (lastState === 'blocked') throw new Error(`OpenCode pane ${sessionName} is blocked`)
        if (lastState === 'idle') {
          const candidates = await this.sessionsCreatedSince(notBeforeMs)
          if (candidates.length === 1) return candidates[0]!
          if (candidates.length > 1) {
            await this.stop(sessionName).catch(() => false)
            throw new Error(
              `OpenCode pane ${sessionName} launch is ambiguous: ${candidates.length} sessions ` +
              `were created since launch (${candidates.join(', ')})`,
            )
          }
        }
      }
      await this.pause(250)
    }
    throw new Error(`OpenCode pane ${sessionName} did not become ready (last state: ${lastState})`)
  }

  // Resolves only after OPENCODE_SETTLE_MS of uninterrupted idle; any other
  // observation restarts the window.
  private async waitUntilIdle(sessionName: string, timeoutMs: number): Promise<OpencodePane> {
    const deadline = Date.now() + timeoutMs
    let idleSince: number | undefined
    while (Date.now() <= deadline) {
      const pane = await this.pane(sessionName)
      if (!pane) throw new Error(`OpenCode pane ${sessionName} is not running`)
      const state = await this.paneStatus(pane)
      if (state === 'blocked') throw new Error(`OpenCode pane ${sessionName} is blocked`)
      if (state === 'idle') {
        idleSince ??= Date.now()
        if (Date.now() - idleSince >= OPENCODE_SETTLE_MS) return pane
      } else {
        idleSince = undefined
      }
      await this.pause(SETTLE_POLL_MS)
    }
    throw new Error(`OpenCode pane ${sessionName} stayed busy for ${timeoutMs}ms`)
  }
}
