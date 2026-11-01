// The body of POST /ask: multipart form fields from a phone shortcut or app,
// checked where they enter.
import type { AskSubmission } from '../ask/ask-service'
import {
  AskRefused,
  DEFAULT_WAIT_MS,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_QUESTION_CHARS,
  MAX_WAIT_MS,
  imageKind,
} from '../ask/domain/ask'

const MAX_URL_CHARS = 2048

const bad = (message: string) => new AskRefused(message, 400)

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name)
  if (value == null) return undefined
  if (typeof value !== 'string') throw bad(`${name} must be text`)
  return value.trim() || undefined
}

async function file(form: FormData, name: string, maxBytes: number): Promise<Uint8Array | undefined> {
  const value = form.get(name)
  if (value == null || value === '') return undefined
  if (typeof value === 'string') throw bad(`${name} must be a file`)
  if (value.size === 0) return undefined
  if (value.size > maxBytes) throw new AskRefused(`${name} is over ${maxBytes / 1024 / 1024} MB`, 413)
  return new Uint8Array(await value.arrayBuffer())
}

function pageUrl(form: FormData): string | undefined {
  const url = text(form, 'url')
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw bad('url must be an http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw bad('url must be an http(s) URL')
  if (url.length > MAX_URL_CHARS) throw bad(`url is over ${MAX_URL_CHARS} characters`)
  return url
}

// Who is asking (the Shortcut, the app), for the log only.
function client(form: FormData): string | undefined {
  const value = text(form, 'client')
  if (value && !/^[A-Za-z0-9._-]{1,32}$/.test(value)) throw bad('client must be 1-32 letters, digits, dots, dashes or underscores')
  return value
}

function waitMs(form: FormData): number {
  const raw = text(form, 'wait')
  if (raw === undefined) return DEFAULT_WAIT_MS
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) throw bad('wait must be a number of seconds')
  return Math.min(seconds * 1000, MAX_WAIT_MS)
}

/** What became of a screenshot sent with an ask. */
export type ImageHandling = 'none' | 'accepted' | 'ignored'

/** With `images` off, a screenshot is neither saved nor posted, and the ask goes ahead without it. */
export async function parseAsk(
  form: FormData,
  { images }: { images: boolean },
): Promise<{ submission: AskSubmission; image: ImageHandling }> {
  const question = text(form, 'question')
  if (question && question.length > MAX_QUESTION_CHARS) throw bad(`question is over ${MAX_QUESTION_CHARS} characters`)
  const audio = question ? undefined : await file(form, 'audio', MAX_AUDIO_BYTES)
  if (!question && !audio) throw bad('question or audio required')
  const sent = form.get('image')
  const offered = sent != null && sent !== '' && !(typeof sent !== 'string' && sent.size === 0)
  const image = offered && images ? await file(form, 'image', MAX_IMAGE_BYTES) : undefined
  const kind = image ? imageKind(image) : undefined
  if (image && !kind) throw bad('image must be a PNG, JPEG, GIF, WebP or HEIC')
  const url = pageUrl(form)
  const from = client(form)
  return {
    submission: {
      ...(from ? { client: from } : {}),
      ...(question ? { question } : {}),
      ...(audio ? { audio } : {}),
      ...(image && kind ? { image: { bytes: image, kind } } : {}),
      ...(url ? { url } : {}),
      waitMs: waitMs(form),
    },
    image: !offered ? 'none' : images ? 'accepted' : 'ignored',
  }
}
