// The OpenCode (localcode) harness: a locked topic runs one OpenCode TUI on the
// local Qwen model in its own Herdr workspace, and Telegram turns are typed into it.
import { join } from 'path'
import { JsonTopicRepository } from '../json-topic-repository'
import { HerdrOpencodeRuntime } from './herdr-opencode-runtime'
import { MAX_CHUNK_LIMIT, threadOf } from '../../telegram/telegram-messages'
import { OpencodeTopicService } from './opencode-topic-service'
import {
  GROUP_CHAT_ID,
  HERDR_BIN,
  HERDR_LAUNCH_SCRIPT,
  OPENCODE_BIN,
  OPENCODE_MODEL,
  OPENCODE_PROJECT_DIR,
  OPENCODE_TOPICS_FILE,
  PLUGIN_ROOT,
  PROXY_URL,
} from '../../config'
import { opencodeTopic, opencodeTopicFromRecord } from './domain/opencode-topic'
import type { OpencodeTopic } from './domain/opencode-topic'
import { log, reason } from '../../log'
import { openOrSetAside } from '../../shared/state-file'
import { saveRegistry } from '../../topics/registry'
import { getTopic, topicNames } from '../../topics/state'
import type { HarnessPorts, TopicHarnessAdapter } from '../topic-harness-adapter'

const LOCALCODE_RE = /^\/localcode(?:@\w+)?\s*$/

export function createOpencodeHarness({ api, sayIn, mayLockTopic }: HarnessPorts): TopicHarnessAdapter {
  const opencodeRepository = openOrSetAside('OpenCode topics', OPENCODE_TOPICS_FILE, () =>
    new JsonTopicRepository<OpencodeTopic>(OPENCODE_TOPICS_FILE, 'OpenCode', opencodeTopicFromRecord), log)
  const opencodeRuntime = new HerdrOpencodeRuntime(
    OPENCODE_BIN,
    OPENCODE_PROJECT_DIR,
    HERDR_LAUNCH_SCRIPT,
    PROXY_URL,
    process.execPath,
    join(PLUGIN_ROOT, 'server.ts'),
    HERDR_BIN,
    undefined,
    undefined,
    OPENCODE_MODEL,
  )
  // Last /send per locked OpenCode topic; the service's reply backstop reads it.
  const opencodeLastSentAt = new Map<string, number>()
  const opencodeService = new OpencodeTopicService(
    opencodeRepository,
    opencodeRuntime,
    {
      typing(topic) {
        void api.sendChatAction(String(GROUP_CHAT_ID), 'typing', threadOf(topic)).catch(() => {})
      },
      async error(topic, text) {
        log(`OpenCode turn failed for topic ${topic}: ${text}`)
        await api.sendMessage(
          String(GROUP_CHAT_ID),
          `⚠️ ${text.slice(0, MAX_CHUNK_LIMIT - 3)}`,
          threadOf(topic),
        )
      },
      repliedSince(topic, sinceMs) {
        return (opencodeLastSentAt.get(topic) ?? 0) >= sinceMs
      },
      async notice(topic, text) {
        log(`OpenCode reply backstop for topic ${topic}: ${text.slice(0, 80)}`)
        await api.sendMessage(
          String(GROUP_CHAT_ID),
          `↩︎ ${text.slice(0, MAX_CHUNK_LIMIT - 2)}`,
          threadOf(topic),
        )
      },
    },
  )

  // Records without a Herdr session name are started at boot so an enabled
  // topic is visible without a throwaway Telegram turn.
  for (const topic of opencodeService.list()) {
    if (topic.sessionName) continue
    void opencodeService.start(topic.topic)
      .then(running => log(
        `started OpenCode topic ${topic.topic} "${topic.name}" in Herdr ` +
        `${running.sessionName} (${running.opencodeSessionId})`,
      ))
      .catch(error => log(`OpenCode Herdr start failed for topic ${topic.topic}: ${error}`))
  }


  const opencodeRouteLabel = () => `OpenCode / local Qwen · ${OPENCODE_MODEL}`

  async function activateLocalcodeTopic(
    chatId: string,
    topic: string,
    fromId: string,
  ): Promise<void> {
    if (!(await mayLockTopic(chatId, topic, fromId, 'opencode'))) return
    const existing = opencodeService.get(topic)
    if (existing) {
      try {
        const running = await opencodeService.start(topic)
        await sayIn(
          chatId,
          topic,
          `This topic is already locked to ${opencodeRouteLabel()} in Herdr workspace ` +
          `${running.sessionName}. Session: ${running.opencodeSessionId}.`,
        )
      } catch (error) {
        await sayIn(chatId, topic, `Could not start the existing OpenCode session: ${reason(error)}`)
      }
      return
    }
    const claude = getTopic(topic)
    try {
      const name = claude.name || topicNames.get(topic) || `localcode ${topic}`
      opencodeService.activate(opencodeTopic(topic, name))
      claude.name = name
      topicNames.set(topic, name)
      saveRegistry()
      await sayIn(chatId, topic, 'Starting OpenCode on the local Qwen model in a persistent Herdr workspace…')
      const running = await opencodeService.start(topic)
      await sayIn(
        chatId,
        topic,
        `Locked this topic to OpenCode / local Qwen (${OPENCODE_MODEL}) in Herdr workspace ${running.sessionName}. ` +
        `Session: ${running.opencodeSessionId}. Other harness/provider routes are disabled here. ` +
        'The first reply takes a few minutes while OpenCode loads its instructions.',
      )
    } catch (error) {
      await sayIn(chatId, topic, `Could not enable OpenCode: ${reason(error)}`)
    }
  }

  // Single-model harness: /model only reports status, there is nothing to pick.
  async function handleOpencodeModelCommand(chatId: string, topic: string, argument: string): Promise<void> {
    const current = opencodeService.get(topic)!
    await sayIn(
      chatId,
      topic,
      `OpenCode session: ${current.opencodeSessionId ?? 'not started'}\n` +
      `Route: ${opencodeRouteLabel()}\n` +
      `Herdr: ${current.sessionName ?? 'not running'} (${await opencodeService.status(topic)})\n` +
      'Harness: OpenCode (locked)\nPermissions: OpenCode defaults\n' +
      'Context: AGENTS.md and ~/.claude/CLAUDE.md native' +
      (argument ? '\n\nThis topic runs a single local model, so there is nothing to pick.' : ''),
    )
  }

  return {
    kind: 'opencode',
    lockCommand: LOCALCODE_RE,
    attachments: 'eager',
    tracesInbound: false,
    owns: topic => opencodeService.isLocked(topic),
    lock: c => activateLocalcodeTopic(c.chatId, c.topic, c.fromId),
    model: (c, argument) => handleOpencodeModelCommand(c.chatId, c.topic, argument),
    usage: ({ chatId, topic }) =>
      sayIn(chatId, topic, 'OpenCode runs on the local Qwen server; there is no quota to report.').then(() => {}),
    relaunch: async ({ chatId, topic }) => {
      const current = opencodeService.get(topic)!
      const result = await opencodeService.requestRelaunch(topic)
      await sayIn(
        chatId,
        topic,
        result.pending
          ? `OpenCode is busy; relaunch is queued for the next idle boundary. It will keep session ` +
            `${current.opencodeSessionId ?? 'not started'} and reopen in Herdr.`
          : `Relaunched OpenCode in Herdr with the same session ` +
            `${result.topic.opencodeSessionId ?? 'not started'} and freshly loaded MCP/configuration.`,
      )
    },
    rename: (topic, name) => opencodeService.rename(topic, name),
    receive: async ({ topic }, turn) => {
      log(`received OpenCode Telegram turn ${turn.messageId ?? '(no id)'} for topic ${topic}`)
      void opencodeService.submitTurn(topic, { content: turn.content, meta: turn.meta })
        .then(() => log(`settled OpenCode Telegram turn ${turn.messageId ?? '(no id)'} for topic ${topic}`))
    },
    sent: (topic, messages) => {
      opencodeLastSentAt.set(topic, Date.now())
      log(`sent OpenCode Telegram reply for topic ${topic} (${messages} message${messages === 1 ? '' : 's'})`)
    },
    prepareTopic: async name => async topic => {
      opencodeService.activate(opencodeTopic(topic, name))
      await opencodeService.start(topic)
    },
    reconcile: () => opencodeService.reconcilePending(),
  }
}
