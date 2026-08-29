import type { ProviderId } from './model-routing'

export type CapacityAvailability = 'available' | 'exhausted' | 'unknown'

export type CapacityWindow = {
  name: string
  usedPercent?: number
  resetsAt?: number
  availability: CapacityAvailability
}

export type ProviderCapacity = {
  provider: ProviderId
  availability: CapacityAvailability
  windows: CapacityWindow[]
  observedAt: number
  resetCredits?: number
}

export type CapacityTransition = 'none' | 'exhausted' | 'reset'

export function availabilityFor(windows: CapacityWindow[]): CapacityAvailability {
  if (windows.some(window => window.availability === 'exhausted')) return 'exhausted'
  if (windows.some(window => window.availability === 'available')) return 'available'
  return 'unknown'
}

export function providerCapacity(
  provider: ProviderId,
  windows: CapacityWindow[],
  observedAt: number,
  resetCredits?: number,
): ProviderCapacity {
  return {
    provider,
    availability: availabilityFor(windows),
    windows,
    observedAt,
    ...(resetCredits === undefined ? {} : { resetCredits }),
  }
}

export function capacityTransition(
  previous: ProviderCapacity | undefined,
  current: ProviderCapacity,
): CapacityTransition {
  if (!previous || previous.availability === current.availability) return 'none'
  if (current.availability === 'exhausted') return 'exhausted'
  if (previous.availability === 'exhausted' && current.availability === 'available') return 'reset'
  return 'none'
}

export function nextResetAt(capacity: ProviderCapacity): number | undefined {
  const future = capacity.windows
    .map(window => window.resetsAt)
    .filter((value): value is number => typeof value === 'number' && value > capacity.observedAt)
    .sort((a, b) => a - b)
  return future[0]
}
