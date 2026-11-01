export function log(m: string): void {
  process.stderr.write(`${new Date().toISOString()} telegram-topics-proxy: ${m}\n`)
}
