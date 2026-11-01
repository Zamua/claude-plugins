// POST /ask, the one route the tailnet reaches. It has its own loopback listener,
// so mounting it on the tailnet exposes nothing of the proxy's internal API.
import { createHash, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import type { AskAnswer, AskSubmission } from '../ask/ask-service'
import { AskRefused } from '../ask/domain/ask'
import { parseAsk } from './ask-request'
import { json } from './response'

export const ASK_PATH = '/ask'

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Whether an Authorization header carries `token`, compared in constant time. */
export function bearerMatches(header: string | null, token: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return !!match && timingSafeEqual(digest(match[1]), digest(token))
}

// Read on every request, so a rotated token applies without a restart.
function readToken(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

export type AskServerPorts = {
  port: number
  tokenFile: string
  /** Whether screenshots are taken; off, they are ignored. */
  images: boolean
  ask: (submission: AskSubmission) => Promise<AskAnswer>
  log: (m: string) => void
}

export function createAskServer({ port, tokenFile, images, ask, log }: AskServerPorts) {
  async function route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
    // tailscale serve hands a request on with or without its mount path
    if (path !== ASK_PATH && path !== '/') return json({ error: 'not found' }, 404)
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
    const token = readToken(tokenFile)
    if (!token) return json({ error: 'asks are not configured' }, 503)
    if (!bearerMatches(req.headers.get('authorization'), token)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      })
    }
    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return json({ error: 'body must be multipart/form-data' }, 400)
    }
    const { submission, image } = await parseAsk(form, { images })
    const answered = await ask(submission)
    return json({
      id: String(answered.messageId),
      topic: answered.topic,
      message_id: answered.messageId,
      question: answered.question,
      answer: answered.answer,
      image,
    })
  }

  // Binds the port, retrying while a replaced proxy releases it. A port that never
  // frees turns asks off rather than the proxy.
  async function serve(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        Bun.serve({
          port,
          hostname: '127.0.0.1',
          idleTimeout: 240, // > transcription plus the longest answer wait
          maxRequestBodySize: 50 * 1024 * 1024,
          async fetch(req) {
            try {
              return await route(req)
            } catch (e) {
              if (e instanceof AskRefused) return json({ error: e.message }, e.status)
              log(`ask failed: ${e}`)
              return json({ error: 'internal error' }, 500)
            }
          },
        })
        log(`ask listening on http://127.0.0.1:${port}${ASK_PATH}`)
        return
      } catch (e) {
        if (attempt >= 10) {
          log(`ask port ${port} still busy after ${attempt} attempts; asks are off until the next restart: ${e}`)
          return
        }
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }

  return { serve }
}
