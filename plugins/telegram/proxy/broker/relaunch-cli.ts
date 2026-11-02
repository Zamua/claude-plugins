// The root agent's relaunch command:
//
//   bun broker/relaunch-cli.ts <topic>...
//
// Prints one line per topic: applied, queued (at its turn's end), no_agent, or
// refused with the reason. Exits 1 when anything was refused.
import { homedir } from 'os'
import { join } from 'path'
import { connect } from 'net'

const socketPath = process.env.TELEGRAM_TOPICS_BROKER_SOCKET
  ?? join(process.env.TELEGRAM_TOPICS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram-topics'), 'broker.sock')

type Answer = { error?: string; results?: Array<{ topic: string; outcome: string; reason?: string }> }

function ask(topics: string[]): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let reply = ''
    const socket = connect(socketPath, () => socket.write(`${JSON.stringify({ op: 'relaunch', topics })}\n`))
    socket.setEncoding('utf8')
    socket.on('data', chunk => (reply += chunk))
    socket.on('end', () => {
      try {
        resolve(JSON.parse(reply))
      } catch {
        reject(new Error(`no answer from the broker: ${reply.trim() || '(empty)'}`))
      }
    })
    socket.on('error', reject)
  })
}

const topics = process.argv.slice(2)
if (!topics.length) {
  console.error('usage: relaunch-cli.ts <topic>...')
  process.exit(2)
}
try {
  const answer = await ask(topics)
  if (answer.error) throw new Error(answer.error)
  for (const r of answer.results ?? []) console.log(`${r.topic} ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`)
  process.exit(answer.results?.some(r => r.outcome === 'refused') ? 1 : 0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
