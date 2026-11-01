// Whether the hc core still holds Full Disk Access, as a protected-folder read in
// its session shows. The operator hears of a change, not of every probe.

/** `unknown`: the core is down or the probe did not run, which says nothing either way. */
export type FullDiskAccessProbe = 'allowed' | 'denied' | 'unknown'

export type FullDiskAccessWatch = { last?: 'allowed' | 'denied' }

export type FullDiskAccessNotice = 'lost' | 'restored'

export function nextFullDiskAccessWatch(
  watch: FullDiskAccessWatch,
  probe: FullDiskAccessProbe,
): { watch: FullDiskAccessWatch; notice?: FullDiskAccessNotice } {
  if (probe === 'unknown') return { watch }
  if (probe === 'denied') return { watch: { last: 'denied' }, ...(watch.last !== 'denied' && { notice: 'lost' as const }) }
  return { watch: { last: 'allowed' }, ...(watch.last === 'denied' && { notice: 'restored' as const }) }
}

/** What the operator reads; `binary` is the file the grant belongs to. */
export function fullDiskAccessNoticeText(notice: FullDiskAccessNotice, session: string, binary: string): string {
  if (notice === 'restored') return `✅ hc topics have Full Disk Access again (hc session ${session}).`
  return (
    `⚠️ hc topics lost Full Disk Access: a protected-folder read in hc session ${session} was denied. ` +
    `An hc update replaces the binary, and the grant no longer matches it: grant Full Disk Access again to ` +
    `${binary} (System Settings > Privacy & Security > Full Disk Access). If it persists, another process ` +
    `started or restarted the core: restart it through its launchd agent.`
  )
}
