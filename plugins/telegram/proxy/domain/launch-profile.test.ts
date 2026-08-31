import { describe, expect, test } from 'bun:test'
import { launchProfileNeedsRefresh } from './launch-profile'

const currentRoute = {
  provider: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'medium' as const,
  ultracode: false,
}

describe('launch profile reconciliation', () => {
  test('refreshes a live pane created before launch profiles were versioned', () => {
    expect(launchProfileNeedsRefresh(undefined, 1, currentRoute, currentRoute)).toBeTrue()
  })

  test('refreshes a legacy route even when the profile version matches', () => {
    const legacy = { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' }
    expect(launchProfileNeedsRefresh(1, 1, legacy, currentRoute)).toBeTrue()
  })

  test('re-adopts a pane only when its version and normalized route match', () => {
    expect(launchProfileNeedsRefresh(1, 1, currentRoute, currentRoute)).toBeFalse()
    expect(launchProfileNeedsRefresh(1, 2, currentRoute, currentRoute)).toBeTrue()
  })
})
