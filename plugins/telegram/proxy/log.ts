import { homedir } from 'os'
import { sep } from 'path'

export function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} telegram-topics-proxy: ${m}\n`)
}

export const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A path under the home directory, shown from ~. */
export const tilde = (p: string) => (p.startsWith(homedir() + sep) ? '~' + p.slice(homedir().length) : p)

// A message meant for the operator that Telegram refused is logged, never dropped silently.
export const noticeFailed = (what: string, topic: string) => (err: unknown) =>
  log(`${what} not sent in topic ${topic}: ${reason(err)}`)
