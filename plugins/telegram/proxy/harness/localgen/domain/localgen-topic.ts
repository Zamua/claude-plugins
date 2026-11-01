export type LocalgenTopic = {
  harness: 'localgen'
  topic: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface LocalgenTopicRepository {
  list(): LocalgenTopic[]
  get(topic: string): LocalgenTopic | undefined
  save(topic: LocalgenTopic): void
}

export function localgenTopic(topic: string, name: string, now = Date.now()): LocalgenTopic {
  if (!topic.trim()) throw new Error('localgen topic id is required')
  return { harness: 'localgen', topic, name: name.trim() || topic, createdAt: now, updatedAt: now }
}

export function localgenTopicFromRecord(value: unknown): LocalgenTopic | undefined {
  const raw = value as any
  if (!raw || raw.harness !== 'localgen') return undefined
  if (typeof raw.topic !== 'string' || typeof raw.name !== 'string') return undefined
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return undefined
  return { harness: 'localgen', topic: raw.topic, name: raw.name, createdAt, updatedAt }
}

// ---- prompt options ---------------------------------------------------------

export const LOCALGEN_DEFAULT_SIZE = '1024x1024'
export const LOCALGEN_DEFAULT_STEPS = 40
export const LOCALGEN_MAX_STEPS = 100
export const LOCALGEN_MAX_N = 4
// The server accepts seed in [0, 2^31 - 4] so that seed + n - 1 stays below 2^31.
export const LOCALGEN_MAX_SEED = 2 ** 31 - LOCALGEN_MAX_N

export type LocalgenOptions = {
  prompt: string
  size: string
  steps: number
  seed: number
  n: number
  // Deliver as a document so Telegram keeps the PNG bytes.
  raw: boolean
  // First-block cache threshold, 0 = off (lossy speedup; the server clamps to [0, 1]).
  cache: number
}

export function randomLocalgenSeed(): number {
  return Math.floor(Math.random() * (LOCALGEN_MAX_SEED - LOCALGEN_MAX_N + 1))
}

const OPTION_RE = /^(size|steps|seed|n|cache):(\S+)$/i

function integer(value: string, lo: number, hi: number, key: string): number | string {
  if (!/^\d+$/.test(value)) return `${key} must be an integer`
  const parsed = Number(value)
  if (parsed < lo || parsed > hi) return `${key} must be in [${lo}, ${hi}]`
  return parsed
}

// `size:WxH steps:N seed:N n:K raw` anywhere in the text are options; the rest
// is the prompt. Returns a user-facing error string for an invalid option.
export function parseLocalgenPrompt(
  text: string,
  seed: () => number = randomLocalgenSeed,
): LocalgenOptions | { error: string } {
  const options: LocalgenOptions = {
    prompt: '',
    size: LOCALGEN_DEFAULT_SIZE,
    steps: LOCALGEN_DEFAULT_STEPS,
    seed: -1,
    n: 1,
    raw: false,
    cache: 0,
  }
  const words: string[] = []
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    if (word.toLowerCase() === 'raw') { options.raw = true; continue }
    const match = OPTION_RE.exec(word)
    if (!match) { words.push(word); continue }
    const key = match[1].toLowerCase()
    const value = match[2]
    if (key === 'size') {
      if (!/^\d+x\d+$/i.test(value)) return { error: 'size must be WxH, e.g. size:1024x1024' }
      options.size = value.toLowerCase()
      continue
    }
    if (key === 'cache') {
      const parsed = Number(value)
      if (!/^\d*\.?\d+$/.test(value) || parsed > 1) return { error: 'cache must be a number in [0, 1], e.g. cache:0.1' }
      options.cache = parsed
      continue
    }
    const hi = key === 'steps' ? LOCALGEN_MAX_STEPS : key === 'n' ? LOCALGEN_MAX_N : LOCALGEN_MAX_SEED
    const parsed = integer(value, key === 'seed' ? 0 : 1, hi, key)
    if (typeof parsed === 'string') return { error: parsed }
    if (key === 'steps') options.steps = parsed
    else if (key === 'n') options.n = parsed
    else options.seed = parsed
  }
  options.prompt = words.join(' ')
  if (!options.prompt) return { error: 'the prompt is empty' }
  if (options.seed < 0) options.seed = seed()
  if (options.seed + options.n - 1 > LOCALGEN_MAX_SEED) {
    return { error: `seed + n - 1 must be at most ${LOCALGEN_MAX_SEED}` }
  }
  return options
}

// ---- server request/response ------------------------------------------------

export type LocalgenRequestBody = {
  prompt: string
  size: string
  steps: number
  seed: number
  n: 1
  response_format: 'b64_json'
  cache_threshold: number
}

// One image per request; `n:K` in the message is K sequential requests.
export function localgenRequestBody(options: LocalgenOptions, seed: number): LocalgenRequestBody {
  return {
    prompt: options.prompt,
    size: options.size,
    steps: options.steps,
    seed,
    n: 1,
    response_format: 'b64_json',
    cache_threshold: options.cache,
  }
}

export function localgenCaption(seed: number, size: string, steps: number, elapsedMs: number): string {
  const total = Math.max(0, Math.round(elapsedMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `seed ${seed} · ${size} · ${steps} steps · ${minutes}m${seconds}s`
}

export type LocalgenFailure =
  | { kind: 'down'; detail: string }
  | { kind: 'warming' }
  | { kind: 'timeout'; afterMs: number }
  | { kind: 'http'; status: number; message: string }
  | { kind: 'bad_response'; detail: string }

// The server's error JSON is `{error: {message, type, code}}`; a 503 while the
// warmup runs says "warming up". Anything else is relayed verbatim.
export function localgenFailureFromHttp(status: number, bodyText: string): LocalgenFailure {
  let message = ''
  try {
    const parsed = JSON.parse(bodyText)
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message
  } catch {}
  if (!message) message = bodyText.trim().slice(0, 300) || `HTTP ${status}`
  if (status === 503 && /warming/i.test(message)) return { kind: 'warming' }
  return { kind: 'http', status, message }
}

export function localgenPngFromResponse(bodyText: string): Uint8Array | LocalgenFailure {
  let parsed: any
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { kind: 'bad_response', detail: 'response is not JSON' }
  }
  const b64 = parsed?.data?.[0]?.b64_json
  if (typeof b64 !== 'string' || !b64) return { kind: 'bad_response', detail: 'response has no data[0].b64_json' }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export function localgenFailureText(failure: LocalgenFailure, startCommand: string): string {
  switch (failure.kind) {
    case 'down':
      return `localgen server is down. Start it from the gpu topic:\n${startCommand}`
    case 'warming':
      return 'warming up, try again in a few minutes'
    case 'timeout':
      return `generation timed out after ${Math.round(failure.afterMs / 60_000)} minutes`
    case 'http':
      return `localgen error (HTTP ${failure.status}): ${failure.message}`
    case 'bad_response':
      return `localgen returned an unreadable response: ${failure.detail}`
  }
}
