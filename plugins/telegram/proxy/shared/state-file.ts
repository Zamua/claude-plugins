import { existsSync, renameSync } from 'fs'

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Opens a state file through `open`. One that cannot be read is moved aside to
 * `<file>.unreadable-<ms>` and opened again empty, so a corrupt file costs its
 * own contents a fresh start rather than the whole proxy a boot crash loop.
 * If it cannot be moved aside this throws, rather than let a later save
 * overwrite it.
 */
export function openOrSetAside<T>(
  label: string,
  file: string,
  open: () => T,
  log: (m: string) => void,
  now = Date.now(),
): T {
  try {
    return open()
  } catch (err) {
    if (!existsSync(file)) throw err
    const aside = `${file}.unreadable-${now}`
    try {
      renameSync(file, aside)
    } catch (renameErr) {
      throw new Error(`${file} is unreadable (${reason(err)}) and could not be moved aside (${reason(renameErr)})`)
    }
    log(`${label}: could not load ${file} (${reason(err)}); moved to ${aside}, starting empty`)
    return open()
  }
}
