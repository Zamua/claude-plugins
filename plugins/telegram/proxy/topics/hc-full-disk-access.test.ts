import { describe, expect, test } from 'bun:test'
import { createFullDiskAccessWatch, probeHcFullDiskAccess } from './hc-full-disk-access'
import type { HcRun } from './hc-full-disk-access'
import type { FullDiskAccessProbe } from './domain/full-disk-access'

const answering = (output: unknown, calls: string[][] = []): HcRun => args => {
  calls.push(args)
  return { status: 0, stdout: JSON.stringify({ address: 't9', state: 'finished', output }) }
}

describe('probeHcFullDiskAccess', () => {
  test('reads the probe terminal\'s verdict outside any parent, then removes the terminal', () => {
    const calls: string[][] = []
    expect(probeHcFullDiskAccess(answering('denied\n', calls), () => true)).toBe('denied')
    expect(probeHcFullDiskAccess(answering('allowed'), () => true)).toBe('allowed')
    expect(calls[0].slice(0, 6)).toEqual(['run', '--json', '--no-parent', '--no-notify', '--name', 'fda-probe'])
    expect(calls[1]).toEqual(['rm', 't9'])
  })

  test('with no core listening it makes no hc call, which would start one', () => {
    const calls: string[][] = []
    expect(probeHcFullDiskAccess(answering('denied', calls), () => false)).toBe('unknown')
    expect(calls).toEqual([])
  })

  test('an answer it cannot read is unknown, never a verdict', () => {
    expect(probeHcFullDiskAccess(() => ({ status: 1, stdout: '' }), () => true)).toBe('unknown')
    expect(probeHcFullDiskAccess(answering('ls: weird'), () => true)).toBe('unknown')
  })
})

test('the watch tells the operator of a loss and a recovery, not of each probe', () => {
  const probes: FullDiskAccessProbe[] = ['allowed', 'denied', 'unknown', 'denied', 'allowed']
  const sent: string[] = []
  const logged: string[] = []
  const watch = createFullDiskAccessWatch({
    probe: () => probes.shift() ?? 'unknown',
    notify: t => sent.push(t),
    log: m => logged.push(m),
    session: 'topics',
    binary: () => '/bin/herdr-core',
  })
  for (let i = 0; i < 5; i++) watch.check()
  expect(sent).toHaveLength(2)
  expect(sent[0]).toContain('hc topics lost Full Disk Access')
  expect(sent[1]).toContain('hc topics have Full Disk Access again')
  expect(logged).toEqual([
    'hc session topics: Full Disk Access allowed',
    'hc session topics: Full Disk Access denied',
    'hc session topics: Full Disk Access allowed',
  ])
})
