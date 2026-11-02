// The broker's unix socket: one JSON request per connection, answered with one
// JSON line. Who asks is what the kernel says, never what the request says.
import { chmodSync, rmSync } from 'fs'
import { createServer } from 'net'
import type { Socket } from 'net'
import { ancestry, peerPid } from './peer'
import type { RelaunchBroker } from './relaunch-broker'

const MAX_REQUEST = 16 * 1024
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/

export type BrokerRequest = { op: 'relaunch'; topics: string[] }

export function parseBrokerRequest(line: string): BrokerRequest | string {
  let body: unknown
  try {
    body = JSON.parse(line)
  } catch {
    return 'not JSON'
  }
  const { op, topics } = (body ?? {}) as { op?: unknown; topics?: unknown }
  if (op !== 'relaunch') return 'op must be "relaunch"'
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 100 || !topics.every(t => typeof t === 'string' && TOPIC.test(t))) {
    return 'topics must be 1 to 100 topic ids'
  }
  return { op, topics }
}

export function serveBroker(
  path: string,
  broker: RelaunchBroker,
  log: (line: string) => void,
  whoIs: (socket: Socket) => number | undefined = peerPid,
): { close(): void } {
  rmSync(path, { force: true })
  const server = createServer(socket => {
    let buffered = ''
    let answered = false
    // One request per connection: bytes after the first line never run a second one.
    const answer = (body: unknown) => {
      answered = true
      socket.end(`${JSON.stringify(body)}\n`)
    }
    socket.setEncoding('utf8')
    socket.on('error', error => log(`broker: connection error: ${error.message}`))
    socket.on('data', chunk => {
      if (answered) return
      buffered += chunk
      if (buffered.length > MAX_REQUEST) return answer({ error: 'request too large' })
      const end = buffered.indexOf('\n')
      if (end < 0) return
      const request = parseBrokerRequest(buffered.slice(0, end))
      if (typeof request === 'string') return answer({ error: request })
      answered = true
      const pid = whoIs(socket)
      broker
        .request(pid, pid === undefined ? [] : ancestry(pid), request.topics)
        .then(answer, error => answer({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  // Without a listener, a failed bind would be an uncaught error that takes the proxy down.
  server.on('error', error => log(`broker: off, cannot listen on ${path}: ${error.message}`))
  server.listen(path, () => {
    chmodSync(path, 0o600)
    log(`broker: listening on ${path}`)
  })
  return {
    close() {
      server.close()
      rmSync(path, { force: true })
    },
  }
}
