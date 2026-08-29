import { readFileSync } from 'fs'
import { providerCapacity } from '../domain/provider-capacity'
import type { CapacityWindow, ProviderCapacity } from '../domain/provider-capacity'

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

export function readOpenCodeGoKey(authFile: string): string {
  const parsed = JSON.parse(readFileSync(authFile, 'utf8'))
  const key = parsed?.['opencode-go']?.key
  if (typeof key !== 'string' || !key.trim()) throw new Error('OpenCode Go API key not found')
  return key.trim()
}

export function parseOpenCodeGoCapacity(payload: any, now: number): ProviderCapacity {
  const names: Array<[string, string]> = [
    ['rolling', '5 hour'],
    ['weekly', 'weekly'],
    ['monthly', 'monthly'],
  ]
  const windows: CapacityWindow[] = names.flatMap(([key, name]) => {
    const raw = payload?.usage?.[key]
    if (!raw) return []
    const percent = Number(raw.percent)
    const reset = Date.parse(String(raw.resetsAt ?? ''))
    return [{
      name,
      ...(Number.isFinite(percent) ? { usedPercent: percent } : {}),
      ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
      availability: raw.status === 'rate-limited' || percent >= 100 ? 'exhausted' : 'available',
    }]
  })
  return providerCapacity('opencode-go', windows, now)
}

export async function readOpenCodeGoCapacity(authFile: string): Promise<ProviderCapacity> {
  const key = readOpenCodeGoKey(authFile)
  const response = await fetch(OPENCODE_GO_USAGE_URL, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new Error(`OpenCode Go usage returned HTTP ${response.status}`)
  return parseOpenCodeGoCapacity(await response.json(), Date.now())
}
