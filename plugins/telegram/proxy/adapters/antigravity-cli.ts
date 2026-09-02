import { spawn } from 'child_process'
import type {
  AntigravityModel,
  AntigravityRoute,
} from '../domain/antigravity-topic'
import type { AntigravityEffort } from '../domain/antigravity-topic'
import type {
  AntigravityRuntimePort,
  AntigravityTurn,
  AntigravityTurnResult,
  AntigravityUsageWindow,
} from '../application/antigravity-ports'

export type {
  AntigravityRuntimePort,
  AntigravityTurn,
  AntigravityTurnResult,
  AntigravityUsageWindow,
} from '../application/antigravity-ports'

const EFFORTS: AntigravityEffort[] = ['low', 'medium', 'high']

export function parseAntigravityModels(output: string): AntigravityModel[] {
  const groups = new Map<string, {
    label: string
    variants: Partial<Record<AntigravityEffort, string>>
    concrete?: string
  }>()

  for (const line of output.split(/\r?\n/)) {
    const [rawId, rawLabel] = line.split('\t')
    const id = rawId?.trim()
    const label = rawLabel?.trim()
    if (!id || !label) continue

    const idEffort = id.match(/-(low|medium|high)$/)?.[1] as AntigravityEffort | undefined
    const labelEffort = label.match(/ \((Low|Medium|High)\)$/)?.[1]?.toLowerCase() as
      | AntigravityEffort
      | undefined
    const isConcreteVariant = idEffort && labelEffort === idEffort
    const baseId = isConcreteVariant ? id.slice(0, -(idEffort.length + 1)) : id
    const baseLabel = isConcreteVariant ? label.replace(/ \((Low|Medium|High)\)$/, '') : label
    const group = groups.get(baseId) ?? { label: baseLabel, variants: {} }
    if (isConcreteVariant) group.variants[idEffort] = id
    else group.concrete = id
    groups.set(baseId, group)
  }

  return [...groups.entries()].map(([id, group]) => {
    const variantEfforts = EFFORTS.filter(effort => group.variants[effort])
    const efforts = variantEfforts.length ? variantEfforts : [...EFFORTS]
    const defaultEffort = efforts.includes('medium') ? 'medium' : efforts[0]
    return {
      id: group.concrete ?? id,
      label: group.label,
      variants: group.variants,
      efforts,
      defaultEffort,
    }
  })
}

export function antigravityArgs(input: AntigravityTurn): string[] {
  return [
    '--model', input.modelVariant,
    '--effort', input.effort,
    '--dangerously-skip-permissions',
    '--output-format', 'json',
    '--print-timeout', '30m',
    ...(input.conversationId ? ['--conversation', input.conversationId] : []),
    '-p', input.prompt,
  ]
}

export function parseAntigravityResult(output: string): AntigravityTurnResult {
  const parsed = JSON.parse(output.trim()) as Record<string, unknown>
  const conversationId = String(parsed.conversation_id ?? '').trim()
  const response = String(parsed.response ?? '').trim()
  const status = String(parsed.status ?? '').trim()
  if (!conversationId) throw new Error('Antigravity returned no conversation id')
  if (!status) throw new Error('Antigravity returned no status')
  if (status !== 'SUCCESS') {
    throw new Error(response || `Antigravity turn ended with ${status}`)
  }
  return { conversationId, response, status }
}

export function parseAntigravityUsage(output: string): AntigravityUsageWindow[] {
  const windows: AntigravityUsageWindow[] = []
  const textPattern = /^(.+?)\s+(weekly|five-hour):\s+(\d+(?:\.\d+)?)%\s+remaining\s+\(resets\s+([^\)]+)\)$/i
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    const tab = line.split('\t')
    const match = line.match(textPattern)
    const pool = tab.length === 4 ? tab[0] : match?.[1]
    const window = tab.length === 4
      ? tab[1].replace(/ Limit Remaining$/i, '').replace(/Five Hour/i, 'five-hour').toLowerCase()
      : match?.[2].toLowerCase()
    const remaining = tab.length === 4 ? tab[2].replace(/%$/, '') : match?.[3]
    const reset = tab.length === 4 ? tab[3] : match?.[4]
    if (!pool || !window || !remaining || !reset) continue
    const resetsAt = Date.parse(reset)
    if (!Number.isFinite(resetsAt)) continue
    windows.push({
      pool,
      window,
      remainingPercent: Number(remaining),
      resetsAt,
    })
  }
  return windows
}

type ExecResult = { stdout: string; stderr: string }
type Exec = (args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>

function nodeExec(binary: string): Exec {
  return (args, options) => new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const collect = (target: 'stdout' | 'stderr', data: Buffer) => {
      if (target === 'stdout') stdout += data.toString()
      else stderr += data.toString()
      if (stdout.length + stderr.length > 16 * 1024 * 1024) {
        child.kill('SIGTERM')
        finish(new Error('Antigravity CLI output exceeded 16 MiB'))
      }
    }
    child.stdout.on('data', data => collect('stdout', data))
    child.stderr.on('data', data => collect('stderr', data))
    child.once('error', error => finish(error))
    // Antigravity starts a helper language-server process that can briefly
    // inherit the parent's pipe descriptors. Node's `close` event waits for
    // those descendant descriptors and can hang even after the CLI itself has
    // exited. The `exit` event is the correct ownership boundary; one turn of
    // the event loop lets the parent process's final buffered data arrive.
    child.once('exit', (code, signal) => {
      setTimeout(() => {
        if (code === 0) finish()
        else {
          const detail = (stderr || stdout).trim()
          finish(new Error(detail || `Antigravity exited ${code ?? signal ?? 'unknown'}`))
        }
      }, 25)
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error(`Antigravity CLI timed out after ${options.timeout}ms`))
    }, options.timeout)
  })
}

export class AntigravityCli implements AntigravityRuntimePort {
  private readonly exec: Exec

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    exec?: Exec,
  ) {
    this.exec = exec ?? nodeExec(binary)
  }

  async models(): Promise<AntigravityModel[]> {
    const result = await this.exec(['models'], { cwd: this.cwd, timeout: 60_000 })
    const models = parseAntigravityModels(result.stdout)
    if (!models.length) throw new Error('Antigravity returned an empty model catalog')
    return models
  }

  async usage(): Promise<AntigravityUsageWindow[]> {
    const result = await this.exec(['-p', '/usage'], { cwd: this.cwd, timeout: 60_000 })
    return parseAntigravityUsage(result.stdout)
  }

  async turn(input: AntigravityTurn): Promise<AntigravityTurnResult> {
    const result = await this.exec(antigravityArgs(input), { cwd: this.cwd, timeout: 31 * 60_000 })
    return parseAntigravityResult(result.stdout)
  }
}

export function routeLabel(route: AntigravityRoute): string {
  return `Google / Antigravity · ${route.modelLabel} · ${route.effort}`
}
