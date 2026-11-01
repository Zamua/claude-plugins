// Takes an ask from the phone into its topic: the post the operator sees there,
// the turn its agent answers, and the agent's first answer back to the phone when
// it comes in time.
import { InputFile } from 'grammy'
import type { Api } from 'grammy'
import type { TopicRoute } from '../routing/domain/model-routing'
import type { InboundMessage } from '../shared/domain/inbound-delivery'
import { messageLink, threadOf } from '../telegram/telegram-messages'
import {
  AskRefused,
  DEDICATED_TOPIC_NAME,
  DEDICATED_TOPIC_ROUTE,
  MAX_QUESTION_CHARS,
  askCaption,
  askTurn,
} from './domain/ask'
import type { AskTarget, ImageKind } from './domain/ask'

export type AskSubmission = {
  question?: string
  audio?: Uint8Array
  image?: { bytes: Uint8Array; kind: ImageKind }
  url?: string
  /** Who is asking, for the log. */
  client?: string
  waitMs: number
}

export type AskAnswer = {
  topic: string
  /** The ask's post in the topic. */
  messageId: number
  /** A deep link to the post, where later answers arrive, when the chat has one. */
  link: string | null
  question: string
  /** The agent's first reply to the post, or null when none came within the wait. */
  answer: string | null
}

export type AskPorts = {
  api: Pick<Api, 'sendPhoto' | 'sendDocument' | 'sendMessage'>
  chatId: string
  /** Undefined when the configured target is malformed. */
  target: AskTarget | undefined
  /** The dedicated topic, once created. */
  store: { topic(): string | undefined; save(topic: string): void }
  createTopic: (name: string) => Promise<string>
  routeTopic: (topic: string, route: TopicRoute) => void
  /** Why `topic` cannot take an ask, when it cannot. */
  refusal: (topic: string) => string | undefined
  ensureSession: (topic: string) => void
  enqueue: (topic: string, message: InboundMessage) => void
  /** Keeps the image where inbound photos are kept and gives its path. */
  saveImage: (bytes: Uint8Array, kind: ImageKind) => string
  transcribe: (audio: Uint8Array) => Promise<string | null>
  log: (m: string) => void
  now?: () => number
}

export function createAsk(ports: AskPorts) {
  const { api, chatId, store, log } = ports
  const now = ports.now ?? Date.now
  /** Asks waiting for their first answer, by their post's message id. */
  const waiting = new Map<number, { topic: string; answer: (text: string) => void }>()
  let creating: Promise<string> | undefined

  async function questionOf(s: AskSubmission): Promise<{ text: string; transcribed: boolean }> {
    if (s.question) return { text: s.question, transcribed: false }
    if (!s.audio) throw new AskRefused('a question or an audio recording is required', 'invalid')
    const text = (await ports.transcribe(s.audio))?.trim()
    if (!text) throw new AskRefused('the audio could not be transcribed', 'unintelligible')
    return { text: text.slice(0, MAX_QUESTION_CHARS), transcribed: true }
  }

  async function targetTopic(): Promise<string> {
    const target = ports.target
    if (!target) throw new AskRefused('TELEGRAM_ASK_TOPIC is neither a thread id nor "general"', 'unavailable')
    if (target.kind === 'configured') return target.topic
    const known = store.topic()
    if (known) return known
    // Concurrent first asks share one creation
    creating ??= createDedicated().finally(() => {
      creating = undefined
    })
    return creating
  }

  async function createDedicated(): Promise<string> {
    let topic: string
    try {
      topic = await ports.createTopic(DEDICATED_TOPIC_NAME)
    } catch (e) {
      throw new AskRefused(`could not create the ask topic: ${e}`, 'unposted')
    }
    store.save(topic)
    ports.routeTopic(topic, DEDICATED_TOPIC_ROUTE)
    log(`ask: created the dedicated ask topic ${topic}`)
    return topic
  }

  // The photo, else the image as a document, else the question alone: the operator
  // should see their question even when Telegram refuses the image.
  async function post(topic: string, caption: string, imagePath?: string): Promise<number> {
    const where = threadOf(topic)
    if (imagePath) {
      try {
        return (await api.sendPhoto(chatId, new InputFile(imagePath), { ...where, caption })).message_id
      } catch (e) {
        log(`ask: Telegram refused the screenshot as a photo (${e}); sending it as a document`)
      }
      try {
        return (await api.sendDocument(chatId, new InputFile(imagePath), { ...where, caption })).message_id
      } catch (e) {
        log(`ask: Telegram refused the screenshot as a document (${e}); posting the question alone`)
      }
    }
    try {
      return (await api.sendMessage(chatId, caption, where)).message_id
    } catch (e) {
      throw new AskRefused(`could not post the ask in Telegram: ${e}`, 'unposted')
    }
  }

  function firstAnswer(topic: string, messageId: number, waitMs: number): Promise<string | null> {
    if (waitMs <= 0) return Promise.resolve(null)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        waiting.delete(messageId)
        resolve(null)
      }, waitMs)
      waiting.set(messageId, {
        topic,
        answer: text => {
          clearTimeout(timer)
          waiting.delete(messageId)
          resolve(text)
        },
      })
    })
  }

  async function ask(s: AskSubmission): Promise<AskAnswer> {
    const question = await questionOf(s)
    const topic = await targetTopic()
    const refused = ports.refusal(topic)
    if (refused) throw new AskRefused(refused, 'unavailable')
    const imagePath = s.image ? ports.saveImage(s.image.bytes, s.image.kind) : undefined
    const messageId = await post(topic, askCaption(question.text, s.url), imagePath)
    const started = now()
    // Waiting before the turn is queued, so an answer however fast is not missed
    const answer = firstAnswer(topic, messageId, s.waitMs)
    ports.ensureSession(topic)
    ports.enqueue(topic, askTurn({
      question: question.text,
      transcribed: question.transcribed,
      ...(s.url ? { url: s.url } : {}),
      ...(imagePath ? { imagePath } : {}),
      chatId,
      topic,
      messageId,
      now: started,
    }))
    log(`ask: ${messageId} in topic ${topic} from ${s.client ?? 'an unnamed client'} (${question.transcribed ? 'voice' : 'text'}${imagePath ? ', screenshot' : ''})`)
    const text = await answer
    log(`ask: ${messageId} ${text != null ? `answered in ${now() - started}ms` : `not answered within ${s.waitMs}ms`}`)
    return { topic, messageId, link: messageLink(chatId, topic, messageId), question: question.text, answer: text }
  }

  /** A reply went out in `topic`. The first to an ask's post is that ask's answer. */
  function replied(topic: string, replyTo: number | undefined, text: string): void {
    if (replyTo == null || !text) return
    const pending = waiting.get(replyTo)
    if (pending && pending.topic === topic) pending.answer(text)
  }

  return { ask, replied }
}
