import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

// The temp file is created 0600 and chmod'ed (writeFileSync's mode is subject to
// umask), then renamed over the target, so a reader sees the old or the new file,
// never a partial one, and the state is never readable by other users.
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}
