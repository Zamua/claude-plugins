import { spawn } from 'child_process'
import type { ProviderModel } from './provider-catalog'
import type { Effort } from '../domain/model-routing'
import { providerCapacity } from '../domain/provider-capacity'
import type { CapacityWindow, ProviderCapacity } from '../domain/provider-capacity'

type RpcResponse = { id?: number; result?: any; error?: any }

const CLAUDE_EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'xhigh', 'max'])

export type CodexSnapshot = {
  models: ProviderModel[]
  capacity: ProviderCapacity
}

export function parseCodexModels(result: any): ProviderModel[] {
  const out: ProviderModel[] = []
  for (const raw of result?.data ?? []) {
    if (raw?.hidden) continue
    const id = String(raw?.model ?? raw?.id ?? '')
    if (!id.startsWith('gpt-')) continue
    const efforts = (raw?.supportedReasoningEfforts ?? [])
      .map((option: any) => String(option?.reasoningEffort ?? ''))
      .filter((value: string): value is Effort => CLAUDE_EFFORTS.has(value as Effort))
    const defaultEffort = CLAUDE_EFFORTS.has(raw?.defaultReasoningEffort)
      ? raw.defaultReasoningEffort as Effort
      : efforts.includes('high') ? 'high' : efforts[0] ?? 'medium'
    out.push({
      id,
      label: String(raw?.displayName ?? id),
      efforts: efforts.length ? efforts : ['medium'],
      defaultEffort,
    })
    const priority = (raw?.serviceTiers ?? []).some((tier: any) => tier?.id === 'priority')
    if (priority) {
      out.push({
        id: `${id}-fast`,
        label: `${String(raw?.displayName ?? id)} Fast`,
        efforts: efforts.length ? efforts : ['medium'],
        defaultEffort,
      })
    }
  }
  return out
}

function windowName(raw: any, fallback: string): string {
  const minutes = Number(raw?.windowDurationMins)
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback
  if (minutes % (7 * 24 * 60) === 0) return `${minutes / (7 * 24 * 60)} week`
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day`
  if (minutes % 60 === 0) return `${minutes / 60} hour`
  return `${minutes} minute`
}

export function parseCodexCapacity(result: any, now: number): ProviderCapacity {
  const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits ?? {}
  const providerExhausted = !!snapshot?.rateLimitReachedType || snapshot?.spendControlReached === true
  const windows: CapacityWindow[] = []
  for (const [key, raw] of [['primary', snapshot?.primary], ['secondary', snapshot?.secondary]] as const) {
    if (!raw) continue
    const usedPercent = Number(raw.usedPercent)
    const exhausted = providerExhausted || usedPercent >= 100
    const resets = Number(raw.resetsAt)
    windows.push({
      name: windowName(raw, key),
      ...(Number.isFinite(usedPercent) ? { usedPercent } : {}),
      ...(Number.isFinite(resets) && resets > 0 ? { resetsAt: resets * 1000 } : {}),
      availability: exhausted ? 'exhausted' : 'available',
    })
  }
  return providerCapacity(
    'codex',
    windows,
    now,
    Number(result?.rateLimitResetCredits?.availableCount ?? 0),
  )
}

export async function readCodexSnapshot(codexBin = 'codex'): Promise<CodexSnapshot> {
  const responses = await appServerRequests(codexBin, [
    { id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } },
    { id: 3, method: 'account/rateLimits/read' },
  ])
  return {
    models: parseCodexModels(responses.get(2)),
    capacity: parseCodexCapacity(responses.get(3), Date.now()),
  }
}

function appServerRequests(
  codexBin: string,
  requests: Array<{ id: number; method: string; params?: unknown }>,
): Promise<Map<number, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const results = new Map<number, any>()
    let buffer = ''
    let initialized = false
    let settled = false
    const timer = setTimeout(() => finish(new Error('Codex app-server request timed out')), 15_000)

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolve(results)
    }

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.on('error', error => finish(error))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let response: RpcResponse
        try {
          response = JSON.parse(line)
        } catch {
          continue
        }
        if (response.id === 1 && !initialized) {
          if (response.error) return finish(new Error(String(response.error?.message ?? response.error)))
          initialized = true
          send({ method: 'initialized' })
          for (const request of requests) send(request)
          continue
        }
        if (typeof response.id === 'number' && requests.some(request => request.id === response.id)) {
          if (response.error) return finish(new Error(String(response.error?.message ?? response.error)))
          results.set(response.id, response.result)
          if (results.size === requests.length) finish()
        }
      }
    })

    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'telegram-topics', version: '0.1.0' } },
    })
  })
}
