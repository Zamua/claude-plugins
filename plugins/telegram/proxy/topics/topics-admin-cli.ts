// Archive, restore or rename projects through the proxy's loopback API:
//
//   bun topics/topics-admin-cli.ts archive <topic>...
//   bun topics/topics-admin-cli.ts restore <topic>...
//   bun topics/topics-admin-cli.ts rename <topic> <name>
//
// Prints `<topic> <outcome>` per topic and exits 1 when any was unknown or refused.
const proxy = process.env.TELEGRAM_PROXY_URL ?? `http://127.0.0.1:${process.env.TELEGRAM_PROXY_PORT ?? 8790}`

type Result = { topic: string; outcome: string; reason?: string }

const [verb, ...rest] = process.argv.slice(2)
const request =
  verb === 'archive' || verb === 'restore'
    ? rest.length ? { path: `/topic/${verb}`, body: { topics: rest } } : undefined
    : verb === 'rename' && rest.length >= 2
      ? { path: '/topic/rename', body: { topic: rest[0], name: rest.slice(1).join(' ') } }
      : undefined
if (!request) {
  console.error('usage: topics-admin-cli.ts archive|restore <topic>...  |  rename <topic> <name>')
  process.exit(2)
}
async function main(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${proxy}${path}`, { method: 'POST', body: JSON.stringify(body) })
  const answer = (await res.json()) as { results?: Result[]; error?: string }
  if (!res.ok || !answer.results) throw new Error(answer.error ?? `HTTP ${res.status}`)
  for (const r of answer.results) console.log(`${r.topic} ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`)
  return answer.results.some(r => r.outcome === 'unknown' || r.outcome === 'refused') ? 1 : 0
}

main(request.path, request.body).then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
