import { readFileSync } from 'fs'
import { writeJsonAtomic } from '../shared/json-file'
import type { CapacityWindow, ProviderCapacity } from './domain/provider-capacity'

// Crook reads one window vocabulary across providers ("5 hour", "7 day").
const CROOK_WINDOW_NAMES: Record<string, string> = {
  '1 week': '7 day',
  weekly: '7 day',
}

type UsageWindow = { name: string; used_percent?: number; availability: string; resets_at?: number }

function usageWindow(window: CapacityWindow): UsageWindow {
  return {
    name: CROOK_WINDOW_NAMES[window.name] ?? window.name,
    ...(window.usedPercent === undefined ? {} : { used_percent: window.usedPercent }),
    availability: window.availability,
    ...(window.resetsAt === undefined ? {} : { resets_at: window.resetsAt }),
  }
}

function readProviders(file: string): Record<string, unknown> {
  try {
    const providers = JSON.parse(readFileSync(file, 'utf8'))?.providers
    return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {}
  } catch {
    return {}
  }
}

/**
 * Replaces this provider's windows in Crook's usage file, keeping the other
 * providers', which the status-line hook writes too. A probe with no windows
 * leaves the file alone; an unreadable file is replaced rather than merged.
 */
export function keepProviderUsage(file: string, capacity: ProviderCapacity): void {
  if (!capacity.windows.length) return
  const providers = readProviders(file)
  providers[capacity.provider] = {
    windows: capacity.windows.map(usageWindow),
    observed_at: capacity.observedAt,
  }
  writeJsonAtomic(file, { providers })
}
