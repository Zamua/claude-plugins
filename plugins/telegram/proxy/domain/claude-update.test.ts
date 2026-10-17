import { describe, expect, test } from 'bun:test'
import { compareVersions, LINGERING_SHELL_MS, updateRestartAction } from './claude-update'

const stale = {
  running: '2.1.283',
  installed: '2.1.302',
  activity: 'idle',
  activitySince: 1_000,
  now: 2_000,
  proxyBusy: false,
  deferred: false,
  attempted: false,
}

describe('compareVersions', () => {
  test('orders by numeric segment, not by string', () => {
    expect(compareVersions('2.1.99', '2.1.283')).toBeLessThan(0)
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.1.302', '2.1.302')).toBe(0)
  })

  test('an unparseable version never looks older', () => {
    expect(compareVersions('dev', '2.1.302')).toBe(0)
  })
})

describe('updateRestartAction', () => {
  test('an idle session on an older version is stopped', () => {
    expect(updateRestartAction(stale)).toBe('stop')
  })

  test('a current session is left alone', () => {
    expect(updateRestartAction({ ...stale, running: '2.1.302' })).toBe('none')
    expect(updateRestartAction({ ...stale, running: '2.1.303' })).toBe('none')
  })

  test('mid-turn, background work, a pending prompt and proxy-held work all wait', () => {
    for (const activity of ['busy', 'shell', 'waiting', undefined]) {
      expect(updateRestartAction({ ...stale, activity })).toBe('wait')
    }
    expect(updateRestartAction({ ...stale, proxyBusy: true })).toBe('wait')
  })

  test('background processes left running past the grace period count as idle', () => {
    const shell = { ...stale, activity: 'shell', activitySince: 0 }
    expect(updateRestartAction({ ...shell, now: LINGERING_SHELL_MS - 1 })).toBe('wait')
    expect(updateRestartAction({ ...shell, now: LINGERING_SHELL_MS })).toBe('stop')
    expect(updateRestartAction({ ...shell, activitySince: undefined, now: LINGERING_SHELL_MS })).toBe('wait')
    expect(updateRestartAction({ ...stale, activity: 'busy', activitySince: 0, now: LINGERING_SHELL_MS })).toBe('wait')
  })

  test('a session that waited is restarted and resumed once idle', () => {
    expect(updateRestartAction({ ...stale, deferred: true })).toBe('restart')
  })

  test('a topic is restarted at most once per installed version', () => {
    expect(updateRestartAction({ ...stale, attempted: true })).toBe('none')
  })

  test('nothing happens without both versions', () => {
    expect(updateRestartAction({ ...stale, running: undefined })).toBe('none')
    expect(updateRestartAction({ ...stale, installed: undefined })).toBe('none')
  })
})
