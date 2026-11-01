import { describe, expect, test } from 'bun:test'
import { fullDiskAccessNoticeText, nextFullDiskAccessWatch } from './full-disk-access'

describe('nextFullDiskAccessWatch', () => {
  test('the operator hears when access is lost, once, and when it comes back', () => {
    let watch = {}
    const notices = (['allowed', 'denied', 'denied', 'allowed', 'allowed'] as const).map(probe => {
      const step = nextFullDiskAccessWatch(watch, probe)
      watch = step.watch
      return step.notice
    })
    expect(notices).toEqual([undefined, 'lost', undefined, 'restored', undefined])
  })

  test('a first probe that is denied is already a loss', () => {
    expect(nextFullDiskAccessWatch({}, 'denied').notice).toBe('lost')
  })

  test('a probe that could not run changes nothing', () => {
    expect(nextFullDiskAccessWatch({ last: 'denied' }, 'unknown')).toEqual({ watch: { last: 'denied' } })
    expect(nextFullDiskAccessWatch({ last: 'allowed' }, 'unknown')).toEqual({ watch: { last: 'allowed' } })
  })
})

test('the loss notice names the binary to grant again', () => {
  expect(fullDiskAccessNoticeText('lost', 'topics', '/opt/hc/herdr-core')).toContain('grant Full Disk Access again to /opt/hc/herdr-core')
  expect(fullDiskAccessNoticeText('restored', 'topics', '/opt/hc/herdr-core')).toContain('Full Disk Access again (hc session topics)')
})
