// Probes the hc core's Full Disk Access by reading a protected folder in a
// throwaway terminal of the topics session, and tells the operator when it
// changes. The grant is pinned to the binary, so an hc update loses it.
import { spawnSync } from 'child_process'
import { fullDiskAccessNoticeText, nextFullDiskAccessWatch } from './domain/full-disk-access'
import type { FullDiskAccessProbe, FullDiskAccessWatch } from './domain/full-disk-access'
import { hcCoreListening, hcEnvironment, hcSocketPath } from './hc-mux'

// Only a privacy refusal counts as denied; any other failure is not about the grant.
const PROBE = 'ls "$HOME/Library/Safari" 2>&1 >/dev/null | grep -q "Operation not permitted" && echo denied || echo allowed'

export type HcRun = (args: string[]) => { status: number | null; stdout: string }

export function hcRun(bin: string, session: string): HcRun {
  const env = hcEnvironment(process.env, session)
  return args => {
    const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 15_000 })
    return { status: r.status, stdout: r.stdout ?? '' }
  }
}

/**
 * The probe never starts a core: with none listening it says nothing. Its
 * terminal is removed after the output is read, since `run --rm` drops it.
 */
export function probeHcFullDiskAccess(run: HcRun, coreUp: () => boolean): FullDiskAccessProbe {
  if (!coreUp()) return 'unknown'
  const r = run(['run', '--json', '--no-parent', '--no-notify', '--name', 'fda-probe', 'sh', '-c', PROBE])
  let finished: { address?: unknown; output?: unknown }
  try {
    finished = JSON.parse(r.stdout)
  } catch {
    return 'unknown'
  }
  if (typeof finished.address === 'string') run(['rm', finished.address])
  const output = String(finished.output ?? '').trim()
  return output === 'allowed' || output === 'denied' ? output : 'unknown'
}

/** The probe for the session's own core, found as hc finds it. */
export function hcFullDiskAccessProbe(bin: string, session: string): () => FullDiskAccessProbe {
  const socket = hcSocketPath(hcEnvironment(process.env, session))
  const run = hcRun(bin, session)
  return () => probeHcFullDiskAccess(run, () => hcCoreListening(socket))
}

export function createFullDiskAccessWatch(ports: {
  probe: () => FullDiskAccessProbe
  notify: (text: string) => void
  log: (m: string) => void
  session: string
  binary: () => string
}): { check: () => void } {
  let watch: FullDiskAccessWatch = {}
  return {
    check() {
      const probe = ports.probe()
      const step = nextFullDiskAccessWatch(watch, probe)
      if (probe !== 'unknown' && probe !== watch.last) ports.log(`hc session ${ports.session}: Full Disk Access ${probe}`)
      watch = step.watch
      if (step.notice) ports.notify(fullDiskAccessNoticeText(step.notice, ports.session, ports.binary()))
    },
  }
}
