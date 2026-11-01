// Pickers: buttons that walk the operator through a choice in a few steps.
import type { ProviderId } from '../../routing/domain/model-routing'
import type { ActionIntent } from './actions'

// A picker's buttons outlive their selection by this long; then it asks for /model again.
export const PICKER_TTL_MS = 10 * 60_000
export const MODELS_PER_PAGE = 8

/** A time as the operator reads it in a notice: weekday, hour and zone. */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })
}

/** The provider and topic of a reset picker posted before switch-back buttons existed, read off its buttons. */
export function legacySwitchBack(siblings: readonly ActionIntent[]): { provider: ProviderId; topic: string } | undefined {
  for (const i of siblings) {
    if (i.kind === 'provider' && i.reason === 'reset') return { provider: i.provider, topic: i.topic }
  }
  return undefined
}
