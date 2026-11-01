// One proxy at a time: Telegram allows a single getUpdates consumer per token,
// and Bun.serve wants the port to itself.
import { execFileSync } from 'child_process'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { log } from '../log'

// SIGTERMs a previous proxy that is still alive (an orphan of a crash would
// otherwise 409 on the token and hold the port), then records this one. The
// poll and bind retries cover the moment while it drains.
export function claimPidFile(pidFile: string): void {
  try {
    const stale = parseInt(readFileSync(pidFile, 'utf8'), 10)
    if (stale > 1 && stale !== process.pid) {
      process.kill(stale, 0) // throws if the pid is dead - nothing to replace
      // A recycled pid must not aim the kill at an unrelated process.
      const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (cmd.includes('proxy.ts')) {
        log(`replacing stale proxy pid=${stale}`)
        process.kill(stale, 'SIGTERM')
      }
    }
  } catch {}
  writeFileSync(pidFile, String(process.pid))
}

// Removes the pid file only while it still names this process.
export function releasePidFile(pidFile: string): void {
  try {
    if (parseInt(readFileSync(pidFile, 'utf8'), 10) === process.pid) rmSync(pidFile)
  } catch {}
}
