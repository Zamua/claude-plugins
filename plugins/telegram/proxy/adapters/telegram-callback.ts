import type { AntigravityEffort } from '../domain/antigravity-topic'
import type { Effort, PickerReason, ProviderId } from '../domain/model-routing'
import type { TopicHarness } from '../domain/topic-harness'

/**
 * Every inline-button action, decoded from or encoded to Telegram callback data.
 * Buttons already posted in chats outlive any deploy, so a format change must
 * keep decoding the old strings.
 */
export type Callback =
  | { kind: 'permission'; behavior: 'allow' | 'deny'; requestId: string }
  | { kind: 'providers'; reason: PickerReason; topic: string }
  | { kind: 'provider'; provider: ProviderId; reason: PickerReason; topic: string }
  | { kind: 'models'; provider: ProviderId; reason: PickerReason; topic: string; page: number }
  | { kind: 'model'; token: string }
  | { kind: 'effort'; token: string; effort: Effort }
  | { kind: 'ultracode'; token: string; on: boolean }
  | { kind: 'usage'; topic: string }
  | { kind: 'switch-back'; provider: ProviderId; topic: string }
  | { kind: 'dismiss' }
  | { kind: 'antigravity-models'; topic: string; page: number }
  | { kind: 'antigravity-model'; token: string }
  | { kind: 'antigravity-effort'; token: string; effort: AntigravityEffort }
  | { kind: 'antigravity-usage'; topic: string }

// Telegram rejects callback_data over 64 bytes.
const MAX_CALLBACK_BYTES = 64

const PROVIDER_CODE: Record<ProviderId, string> = { anthropic: 'a', codex: 'c', 'opencode-go': 'o' }
const REASON_CODE: Record<PickerReason, string> = { manual: 'm', quota: 'q', reset: 'r' }

const fromCode = <T extends string>(codes: Record<T, string>, code: string): T | undefined =>
  (Object.keys(codes) as T[]).find(key => codes[key] === code)

export function encodeCallback(c: Callback): string {
  const data = encode(c)
  if (Buffer.byteLength(data) > MAX_CALLBACK_BYTES) throw new Error(`callback data over 64 bytes: ${data}`)
  return data
}

function encode(c: Callback): string {
  switch (c.kind) {
    case 'permission': return `tgperm:${c.behavior}:${c.requestId}`
    case 'providers': return `tgroute:providers:${REASON_CODE[c.reason]}:${c.topic}`
    case 'provider': return `tgroute:p:${PROVIDER_CODE[c.provider]}:${REASON_CODE[c.reason]}:${c.topic}`
    case 'models':
      return `tgroute:models:${PROVIDER_CODE[c.provider]}:${REASON_CODE[c.reason]}:${c.topic}:${c.page}`
    case 'model': return `tgroute:m:${c.token}`
    case 'effort': return `tgroute:e:${c.token}:${c.effort}`
    case 'ultracode': return `tgroute:u:${c.token}:${c.on ? 1 : 0}`
    case 'usage': return `tgroute:usage:${c.topic}`
    case 'switch-back': return `tgroute:return:${PROVIDER_CODE[c.provider]}:${c.topic}`
    case 'dismiss': return 'tgroute:dismiss'
    case 'antigravity-models': return `agroute:models:${c.topic}:${c.page}`
    case 'antigravity-model': return `agroute:m:${c.token}`
    case 'antigravity-effort': return `agroute:e:${c.token}:${c.effort}`
    case 'antigravity-usage': return `agroute:usage:${c.topic}`
  }
}

export function decodeCallback(data: string): Callback | undefined {
  let m: RegExpExecArray | null
  if ((m = /^tgperm:(allow|deny):(.+)$/.exec(data))) {
    return { kind: 'permission', behavior: m[1] as 'allow' | 'deny', requestId: m[2] }
  }
  if ((m = /^tgroute:providers:([mqr]):(.+)$/.exec(data))) {
    return { kind: 'providers', reason: fromCode(REASON_CODE, m[1])!, topic: m[2] }
  }
  if ((m = /^tgroute:p:([aco]):([mqr]):(.+)$/.exec(data))) {
    return {
      kind: 'provider',
      provider: fromCode(PROVIDER_CODE, m[1])!,
      reason: fromCode(REASON_CODE, m[2])!,
      topic: m[3],
    }
  }
  if ((m = /^tgroute:models:([aco]):([mqr]):([^:]+):(\d+)$/.exec(data))) {
    return {
      kind: 'models',
      provider: fromCode(PROVIDER_CODE, m[1])!,
      reason: fromCode(REASON_CODE, m[2])!,
      topic: m[3],
      page: Number(m[4]),
    }
  }
  if ((m = /^tgroute:m:([a-f0-9]+)$/.exec(data))) return { kind: 'model', token: m[1] }
  if ((m = /^tgroute:e:([a-f0-9]+):(auto|low|medium|high|xhigh|max)$/.exec(data))) {
    return { kind: 'effort', token: m[1], effort: m[2] as Effort }
  }
  if ((m = /^tgroute:u:([a-f0-9]+):([01])$/.exec(data))) return { kind: 'ultracode', token: m[1], on: m[2] === '1' }
  if ((m = /^tgroute:usage:(.+)$/.exec(data))) return { kind: 'usage', topic: m[1] }
  if ((m = /^tgroute:return:([aco]):(.+)$/.exec(data))) {
    return { kind: 'switch-back', provider: fromCode(PROVIDER_CODE, m[1])!, topic: m[2] }
  }
  if (data === 'tgroute:dismiss') return { kind: 'dismiss' }
  if ((m = /^agroute:models:([^:]+):(\d+)$/.exec(data))) {
    return { kind: 'antigravity-models', topic: m[1], page: Number(m[2]) }
  }
  if ((m = /^agroute:m:([a-f0-9]+)$/.exec(data))) return { kind: 'antigravity-model', token: m[1] }
  if ((m = /^agroute:e:([a-f0-9]+):(low|medium|high)$/.exec(data))) {
    return { kind: 'antigravity-effort', token: m[1], effort: m[2] as AntigravityEffort }
  }
  if ((m = /^agroute:usage:(.+)$/.exec(data))) return { kind: 'antigravity-usage', topic: m[1] }
  return undefined
}

/** The topic a callback names outright, so a button replayed in another topic can be refused. */
export function callbackTopic(c: Callback): string | undefined {
  return 'topic' in c ? c.topic : undefined
}

/**
 * The harness whose picker emitted the callback; undefined for controls any
 * harness may use. Telegram data a topic did not emit (an old or forged
 * button) is refused against this.
 */
export function callbackHarness(c: Callback): TopicHarness | undefined {
  if (c.kind === 'permission') return undefined
  return c.kind.startsWith('antigravity-') ? 'antigravity' : 'claude'
}

/** The provider and topic of a reset keyboard posted before switch-back buttons existed. */
export function legacySwitchBack(message: unknown): { provider: ProviderId; topic: string } | undefined {
  const rows = (message as any)?.reply_markup?.inline_keyboard
  if (!Array.isArray(rows)) return undefined
  for (const button of rows.flat()) {
    const c = decodeCallback(String(button?.callback_data ?? ''))
    if (c?.kind === 'provider' && c.reason === 'reset') return { provider: c.provider, topic: c.topic }
  }
  return undefined
}
