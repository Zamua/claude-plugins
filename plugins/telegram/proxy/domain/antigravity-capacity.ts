import type { AntigravityUsageWindow } from '../application/antigravity-ports'

export type AntigravityAvailability = 'available' | 'exhausted'

export function antigravityUsageAvailability(
  windows: AntigravityUsageWindow[],
): Map<string, AntigravityAvailability> {
  const grouped = new Map<string, AntigravityUsageWindow[]>()
  for (const window of windows) {
    const values = grouped.get(window.pool) ?? []
    values.push(window)
    grouped.set(window.pool, values)
  }
  return new Map([...grouped].map(([pool, values]) => [
    pool,
    values.some(value => value.remainingPercent <= 0) ? 'exhausted' : 'available',
  ]))
}

export function antigravityResetPools(
  before: AntigravityUsageWindow[],
  after: AntigravityUsageWindow[],
): string[] {
  if (!before.length) return []
  const oldStatus = antigravityUsageAvailability(before)
  const newStatus = antigravityUsageAvailability(after)
  return [...newStatus.entries()]
    .filter(([pool, status]) => status === 'available' && oldStatus.get(pool) === 'exhausted')
    .map(([pool]) => pool)
}
