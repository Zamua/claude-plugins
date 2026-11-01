import { existsSync, readFileSync } from 'fs'
import { providerCapacity } from './domain/provider-capacity'
import type { CapacityWindow, ProviderCapacity } from './domain/provider-capacity'

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

// The active OpenCode Console login's access token, from `opencode auth export`.
export function consoleLoginToken(exported: string): string | undefined {
  try {
    const login = (JSON.parse(exported) as any[])
      .find(credential => credential?.integrationID === 'opencode' && credential?.active)
    const token = login?.value?.access
    return typeof token === 'string' && token.trim() ? token.trim() : undefined
  } catch {
    return undefined
  }
}

// A plain-text API key file when present, else the Console login. The login
// token is re-read on every call because OpenCode refreshes it.
export function readOpenCodeGoKey(keyFile: string, exportLogin: () => string): string {
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, 'utf8').trim()
    if (key) return key
  }
  const token = consoleLoginToken(exportLogin())
  if (!token) throw new Error('no OpenCode Go API key file and no OpenCode Console login')
  return token
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

export async function readOpenCodeGoCapacity(
  keyFile: string,
  exportLogin: () => string,
): Promise<ProviderCapacity> {
  const key = readOpenCodeGoKey(keyFile, exportLogin)
  const response = await fetch(OPENCODE_GO_USAGE_URL, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new Error(`OpenCode Go usage returned HTTP ${response.status}`)
  return parseOpenCodeGoCapacity(await response.json(), Date.now())
}
