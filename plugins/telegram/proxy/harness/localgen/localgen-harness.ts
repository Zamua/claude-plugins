// The localgen harness: a locked topic's text messages are image prompts for the
// local qwen-image server, and the PNG comes back into the same thread.
import { InputFile } from 'grammy'
import { JsonTopicRepository } from '../json-topic-repository'
import { QwenImageClient } from './qwen-image-client'
import { MAX_CHUNK_LIMIT, threadOf } from '../../telegram/telegram-messages'
import { LocalgenTopicService } from './localgen-topic-service'
import { GROUP_CHAT_ID, LOCALGEN_START_CMD, LOCALGEN_TOPICS_FILE, LOCALGEN_URL } from '../../config'
import { localgenTopic, localgenTopicFromRecord } from './domain/localgen-topic'
import type { LocalgenTopic } from './domain/localgen-topic'
import { log, reason } from '../../log'
import { saveRegistry } from '../../topics/registry'
import { getTopic, topicNames } from '../../topics/state'
import type { HarnessPorts, TopicHarnessAdapter } from '../topic-harness-adapter'

// /localgen [name]: lock the current fresh topic to the image generator.
const LOCALGEN_RE = /^\/localgen(?:@\w+)?(?:\s+(.+?))?\s*$/

export function createLocalgenHarness({ api, sayIn, mayLockTopic }: HarnessPorts): TopicHarnessAdapter {
  const localgenRepository = new JsonTopicRepository<LocalgenTopic>(LOCALGEN_TOPICS_FILE, 'localgen', localgenTopicFromRecord)
  const localgenService = new LocalgenTopicService(
    localgenRepository,
    new QwenImageClient(LOCALGEN_URL, log),
    {
      uploading(topic) {
        void api.sendChatAction(String(GROUP_CHAT_ID), 'upload_photo', threadOf(topic)).catch(() => {})
      },
      // Telegram refuses a photo over 10 MB or with a side past its limits; the
      // document form carries any PNG, so it is the fallback as well as `raw`.
      async photo(topic, png, filename, caption, asDocument) {
        const file = new InputFile(png, filename)
        const opts = { ...threadOf(topic), caption }
        if (!asDocument) {
          try {
            await api.sendPhoto(String(GROUP_CHAT_ID), file, opts)
            return
          } catch (error) {
            log(`localgen sendPhoto failed for topic ${topic}, sending as document: ${error}`)
          }
        }
        await api.sendDocument(String(GROUP_CHAT_ID), new InputFile(png, filename), opts)
      },
      async queued(topic, position) {
        await api.sendMessage(String(GROUP_CHAT_ID), `queued (#${position})`, threadOf(topic))
      },
      async error(topic, text) {
        log(`localgen failed for topic ${topic}: ${text}`)
        await api.sendMessage(
          String(GROUP_CHAT_ID),
          `⚠️ ${text.slice(0, MAX_CHUNK_LIMIT - 3)}`,
          threadOf(topic),
        )
      },
    },
    LOCALGEN_START_CMD,
  )

  const localgenRouteLabel = () => `qwen-image · ${LOCALGEN_URL}`

  // Locks the topic the command was posted in, like /localcode: admin only,
  // never the square, never a topic another harness or a Claude UUID owns. The
  // argument renames the topic record; without one the learned name is kept.
  async function activateLocalgenTopic(
    chatId: string,
    topic: string,
    fromId: string,
    argument: string,
  ): Promise<void> {
    if (!(await mayLockTopic(chatId, topic, fromId, 'localgen'))) return
    if (localgenService.isLocked(topic)) {
      await sayIn(chatId, topic, `This topic is already locked to ${localgenRouteLabel()}.`)
      return
    }
    const claude = getTopic(topic)
    try {
      const name = argument.trim() || claude.name || topicNames.get(topic) || 'localgen'
      localgenService.activate(localgenTopic(topic, name))
      claude.name = name
      topicNames.set(topic, name)
      saveRegistry()
      await sayIn(
        chatId,
        topic,
        `Locked this topic to ${localgenRouteLabel()}. Every text message here is an image prompt; ` +
        'options: size:WxH steps:N seed:N n:K raw. No agent runs in this topic.',
      )
    } catch (error) {
      await sayIn(chatId, topic, `Could not enable localgen: ${reason(error)}`)
    }
  }

  // Single-model harness: /model only reports status, there is nothing to pick.
  async function handleLocalgenModelCommand(chatId: string, topic: string, argument: string): Promise<void> {
    let health = 'not listening'
    try {
      const response = await fetch(`${LOCALGEN_URL}/healthz`, { signal: AbortSignal.timeout(3_000) })
      const body = (await response.json().catch(() => ({}))) as any
      health = `${body.status ?? response.status}` +
        (body.busy != null ? `, busy ${body.busy}, queued ${body.queued}` : '')
    } catch {}
    await sayIn(
      chatId,
      topic,
      `Route: ${localgenRouteLabel()}\nServer: ${health}\n` +
      'Harness: localgen (locked)\nPermissions: none, nothing runs but the generator\n' +
      'Options: size:WxH steps:N seed:N n:K raw' +
      (argument ? '\n\nThis topic runs a single local model, so there is nothing to pick.' : ''),
    )
  }

  return {
    kind: 'localgen',
    lockCommand: LOCALGEN_RE,
    attachments: 'none',
    tracesInbound: true,
    owns: topic => localgenService.isLocked(topic),
    lock: (c, argument) => activateLocalgenTopic(c.chatId, c.topic, c.fromId, argument),
    model: (c, argument) => handleLocalgenModelCommand(c.chatId, c.topic, argument),
    usage: ({ chatId, topic }) =>
      sayIn(chatId, topic, 'localgen runs on the local qwen-image server; there is no quota to report.').then(() => {}),
    relaunch: async ({ chatId, topic }) => {
      await sayIn(chatId, topic, 'localgen runs no agent; there is nothing to relaunch. Restart the qwen-image server from the gpu topic if needed.')
    },
    rename: (topic, name) => localgenService.rename(topic, name),
    // The text is the prompt; nothing is downloaded, queued or spawned.
    receive: async ({ chatId, topic }, turn) => {
      if (typeof turn.text !== 'string') {
        await sayIn(chatId, topic, 'localgen takes text prompts only.')
        return
      }
      log(`received localgen prompt ${turn.messageId ?? '(no id)'} for topic ${topic}`)
      void localgenService.submit(topic, turn.text)
        .then(() => log(`settled localgen prompt ${turn.messageId ?? '(no id)'} for topic ${topic}`))
        .catch(error => log(`localgen prompt ${turn.messageId ?? '(no id)'} for topic ${topic} threw: ${error}`))
    },
    sent: () => {},
    prepareTopic: async name => async topic => {
      localgenService.activate(localgenTopic(topic, name))
    },
  }
}
