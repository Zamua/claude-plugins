// The Antigravity harness: a locked topic runs Google's official agy CLI in its
// own Herdr workspace, with its own model catalog, usage pools and route.
import { homedir } from 'os'
import { join } from 'path'
import { InlineKeyboard } from 'grammy'
import type { Context } from 'grammy'
import { routeLabel as antigravityRouteLabel } from '../adapters/antigravity-cli'
import { syncAntigravityTelegramMcp } from '../adapters/antigravity-mcp-config'
import { claudePluginSkillRoots, syncAntigravitySkills } from '../adapters/antigravity-skill-interop'
import { ANTIGRAVITY_DISABLED_MESSAGE, DisabledAntigravityRuntime } from '../adapters/disabled-antigravity-runtime'
import { HerdrAntigravityRuntime } from '../adapters/herdr-antigravity-runtime'
import { JsonTopicRepository } from '../adapters/json-topic-repository'
import { encodeCallback, formatTime, MODELS_PER_PAGE, PICKER_TTL_MS } from '../adapters/telegram-callback'
import type { Callback } from '../adapters/telegram-callback'
import { MAX_CHUNK_LIMIT, threadOf } from '../adapters/telegram-messages'
import type { AntigravityUsageWindow } from '../application/antigravity-ports'
import { AntigravityTopicService } from '../application/antigravity-topic-service'
import {
  ADMIN_USER_ID,
  ANTIGRAVITY_BIN,
  ANTIGRAVITY_ENABLED,
  ANTIGRAVITY_TOPICS_FILE,
  GROUP_CHAT_ID,
  HERDR_BIN,
  HERDR_LAUNCH_SCRIPT,
  PLUGIN_ROOT,
  PROXY_URL,
  SPAWN_DIR,
} from '../config'
import { antigravityResetPools } from '../domain/antigravity-capacity'
import { antigravityRoute, antigravityTopic, antigravityTopicFromRecord } from '../domain/antigravity-topic'
import type { AntigravityModel, AntigravityTopic } from '../domain/antigravity-topic'
import { log, reason } from '../log'
import { saveRegistry } from '../topics/registry'
import { getTopic, topicNames } from '../topics/state'
import type { HarnessPorts, TopicHarnessAdapter } from './topic-harness-adapter'

// /antigravity: lock the current fresh topic to the Antigravity harness.
const ANTIGRAVITY_RE = /^\/antigravity(?:@\w+)?\s*$/

export function createAntigravityHarness({ api, sayIn, mayLockTopic }: HarnessPorts) {
  const antigravityRepository = new JsonTopicRepository<AntigravityTopic>(
    ANTIGRAVITY_TOPICS_FILE, 'Antigravity', antigravityTopicFromRecord,
  )
  const antigravityRuntime = ANTIGRAVITY_ENABLED
    ? new HerdrAntigravityRuntime(ANTIGRAVITY_BIN, SPAWN_DIR, HERDR_LAUNCH_SCRIPT, PROXY_URL, HERDR_BIN)
    : new DisabledAntigravityRuntime()
  const antigravityService = new AntigravityTopicService(
    antigravityRepository,
    antigravityRuntime,
    {
      typing(topic) {
        void api.sendChatAction(String(GROUP_CHAT_ID), 'typing', threadOf(topic)).catch(() => {})
      },
      async error(topic, text) {
        log(`Antigravity turn failed for topic ${topic}: ${text}`)
        await api.sendMessage(
          String(GROUP_CHAT_ID),
          `⚠️ ${text.slice(0, MAX_CHUNK_LIMIT - 3)}`,
          threadOf(topic),
        )
        if (/limit|quota|resource exhausted/i.test(text)) void refreshAntigravityUsage(true).catch(() => {})
      },
    },
  )

  function syncAntigravityInterop(): void {
    const roots = [
      join(homedir(), '.agents', 'skills'),
      join(homedir(), '.claude', 'skills'),
      ...claudePluginSkillRoots(
        join(homedir(), '.claude', 'settings.json'),
        join(homedir(), '.claude', 'plugins', 'installed_plugins.json'),
        // The proxy itself is the Telegram adapter. Importing either Claude
        // Telegram plugin would start incompatible channel mechanics and risks a
        // second getUpdates consumer for the same token.
        new Set(['telegram']),
      ),
    ]
    try {
      const mcpChanged = syncAntigravityTelegramMcp(
        join(homedir(), '.gemini', 'config', 'mcp_config.json'),
        process.execPath,
        join(PLUGIN_ROOT, 'server.ts'),
      )
      const result = syncAntigravitySkills(
        join(homedir(), '.gemini', 'antigravity-cli', 'skills'),
        roots,
      )
      log(
        `Antigravity interop: Telegram MCP ${mcpChanged ? 'configured' : 'current'}; ` +
        `${result.linked.length} skills linked, ${result.skipped.length} native/existing preserved`,
      )
    } catch (error) {
      log(`Antigravity skill interop failed (turns still work): ${error}`)
    }
  }

  if (ANTIGRAVITY_ENABLED) syncAntigravityInterop()

  // One-time migration from the original headless pilot: those records have no
  // Herdr session name. Start them now so an already-enabled topic becomes
  // visible without requiring the operator to send a throwaway Telegram turn.
  for (const topic of ANTIGRAVITY_ENABLED ? antigravityService.list() : []) {
    if (topic.sessionName) continue
    void antigravityService.start(topic.topic)
      .then(running => log(
        `migrated Antigravity topic ${topic.topic} "${topic.name}" to Herdr ` +
        `${running.sessionName} (${running.conversationId})`,
      ))
      .catch(error => log(`Antigravity Herdr migration failed for topic ${topic.topic}: ${error}`))
  }


  type AntigravityModelSelection = {
    topic: string
    model: AntigravityModel
    expiresAt: number
  }

  const antigravityModelSelections = new Map<string, AntigravityModelSelection>()
  let antigravityCatalogCache: { models: AntigravityModel[]; at: number } | undefined
  let antigravityUsageSnapshot: AntigravityUsageWindow[] = []

  async function antigravityModels(force = false): Promise<AntigravityModel[]> {
    if (!force && antigravityCatalogCache && Date.now() - antigravityCatalogCache.at < 60_000) {
      return antigravityCatalogCache.models
    }
    const models = await antigravityService.models()
    antigravityCatalogCache = { models, at: Date.now() }
    return models
  }

  async function defaultAntigravityRoute() {
    const models = await antigravityModels()
    const model = models.find(candidate => candidate.id === 'gemini-3.8-flash') ?? models[0]
    if (!model) throw new Error('Antigravity has no available subscription models')
    return antigravityRoute(model, model.defaultEffort)
  }

  function antigravitySelection(model: AntigravityModel, topic: string): string {
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    antigravityModelSelections.set(token, {
      topic,
      model,
      expiresAt: Date.now() + PICKER_TTL_MS,
    })
    return token
  }

  function pruneAntigravitySelections(): void {
    const now = Date.now()
    for (const [token, selection] of antigravityModelSelections) {
      if (selection.expiresAt < now) antigravityModelSelections.delete(token)
    }
  }

  async function antigravityModelPicker(
    topic: string,
    page = 0,
  ): Promise<{ text: string; keyboard: InlineKeyboard }> {
    pruneAntigravitySelections()
    const models = await antigravityModels()
    const pages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE))
    const safePage = Math.max(0, Math.min(page, pages - 1))
    const keyboard = new InlineKeyboard()
    for (const model of models.slice(safePage * MODELS_PER_PAGE, (safePage + 1) * MODELS_PER_PAGE)) {
      keyboard.text(model.label, encodeCallback({ kind: 'antigravity-model', token: antigravitySelection(model, topic) })).row()
    }
    if (pages > 1) {
      if (safePage > 0) keyboard.text('Previous', encodeCallback({ kind: 'antigravity-models', topic, page: safePage - 1 }))
      if (safePage + 1 < pages) keyboard.text('Next', encodeCallback({ kind: 'antigravity-models', topic, page: safePage + 1 }))
      keyboard.row()
    }
    keyboard.text('Usage', encodeCallback({ kind: 'antigravity-usage', topic }))
    return {
      text: `Google / Antigravity subscription models${pages > 1 ? ` (${safePage + 1}/${pages})` : ''}:`,
      keyboard,
    }
  }

  function antigravityUsageText(windows: Awaited<ReturnType<AntigravityTopicService['usage']>>): string {
    if (!windows.length) return 'Antigravity subscription usage is temporarily unavailable.'
    const pools = new Map<string, typeof windows>()
    for (const window of windows) {
      const list = pools.get(window.pool) ?? []
      list.push(window)
      pools.set(window.pool, list)
    }
    const lines = [...pools.entries()].map(([pool, values]) =>
      `${pool}:\n${values.map(value =>
        `  ${value.window}: ${value.remainingPercent}% remaining, resets ${formatTime(value.resetsAt)}`,
      ).join('\n')}`,
    )
    return `Google / Antigravity subscription usage\n\n${lines.join('\n\n')}`
  }

  async function refreshAntigravityUsage(notifyResets: boolean): Promise<AntigravityUsageWindow[]> {
    if (!ANTIGRAVITY_ENABLED || !antigravityService.list().length) return []
    try {
      const current = await antigravityService.usage()
      const resets = notifyResets ? antigravityResetPools(antigravityUsageSnapshot, current) : []
      antigravityUsageSnapshot = current
      for (const pool of resets) {
        for (const topic of antigravityService.list()) {
          await api.sendMessage(
            String(GROUP_CHAT_ID),
            `${pool} is available again on your Google / Antigravity subscription. ` +
            'This topic was not switched automatically.',
            {
              ...threadOf(topic.topic),
              reply_markup: new InlineKeyboard()
                .text('Choose Antigravity model', encodeCallback({ kind: 'antigravity-models', topic: topic.topic, page: 0 })),
            },
          ).catch(error => log(`Antigravity reset notice failed for topic ${topic.topic}: ${error}`))
        }
      }
      return current
    } catch (error) {
      log(`Antigravity capacity probe failed: ${error}`)
      throw error
    }
  }

  async function activateAntigravityTopic(
    chatId: string,
    topic: string,
    fromId: string,
  ): Promise<void> {
    if (!(await mayLockTopic(chatId, topic, fromId, 'antigravity'))) return
    if (!ANTIGRAVITY_ENABLED) {
      await sayIn(chatId, topic, ANTIGRAVITY_DISABLED_MESSAGE)
      return
    }
    const existing = antigravityService.get(topic)
    if (existing) {
      try {
        const running = await antigravityService.start(topic)
        await sayIn(
          chatId,
          topic,
          `This topic is already locked to ${antigravityRouteLabel(running.route)} in Herdr workspace ` +
          `${running.sessionName}. Conversation: ${running.conversationId}.`,
        )
      } catch (error) {
        await sayIn(chatId, topic, `Could not start the existing Antigravity session: ${reason(error)}`)
      }
      return
    }
    const claude = getTopic(topic)
    try {
      const route = await defaultAntigravityRoute()
      const name = claude.name || topicNames.get(topic) || `Antigravity ${topic}`
      antigravityService.activate(antigravityTopic(topic, name, route))
      claude.name = name
      topicNames.set(topic, name)
      saveRegistry()
      void refreshAntigravityUsage(false).catch(() => {})
      await sayIn(chatId, topic, `Starting ${antigravityRouteLabel(route)} in a persistent Herdr workspace…`)
      const running = await antigravityService.start(topic)
      await sayIn(
        chatId,
        topic,
        `Locked this topic to ${antigravityRouteLabel(route)} in Herdr workspace ${running.sessionName}. ` +
        `Conversation: ${running.conversationId}. Other harness/provider routes are disabled here. ` +
        'Use /model to switch only among models included with the Antigravity subscription.',
      )
    } catch (error) {
      await sayIn(chatId, topic, `Could not enable Antigravity: ${reason(error)}`)
    }
  }

  async function handleAntigravityModelCommand(
    chatId: string,
    topic: string,
    fromId: string,
    arg: string,
  ): Promise<void> {
    if (!ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
      await sayIn(chatId, topic, 'Only the operator can change this topic\'s model.')
      return
    }
    const current = antigravityService.get(topic)!
    const value = arg.trim().toLowerCase()
    if (value === 'status') {
      await sayIn(
        chatId,
        topic,
        `Antigravity conversation: ${current.conversationId ?? 'not started'}\n` +
        `Route: ${antigravityRouteLabel(current.route)}\n` +
        `Herdr: ${current.sessionName ?? 'not running'} (${await antigravityService.status(topic)})\n` +
        'Harness: Antigravity (locked)\nPermissions: non-interactive; no hard gates\n' +
        'Context: AGENTS.md/GEMINI.md native; CLAUDE.md and Markdown skills via compatibility adapter',
      )
      return
    }
    if (value) {
      await sayIn(
        chatId,
        topic,
        'This topic is harness-locked to Google / Antigravity. Run bare /model and choose from its subscription catalog.',
      )
      return
    }
    try {
      const picker = await antigravityModelPicker(topic)
      await api.sendMessage(chatId, picker.text, { ...threadOf(topic), reply_markup: picker.keyboard })
    } catch (error) {
      await sayIn(chatId, topic, `Could not load Antigravity models: ${reason(error)}`)
    }
  }



  // The Antigravity model picker's buttons; true when the callback was one of them.
  async function handleCallback(ctx: Context, cb: Callback, currentTopic: string): Promise<boolean> {
    if (cb.kind === 'antigravity-models') {
      const topic = cb.topic
      if (topic !== currentTopic || !antigravityService.isLocked(topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return true
      }
      try {
        const picker = await antigravityModelPicker(topic, cb.page)
        await ctx.editMessageText(picker.text, { reply_markup: picker.keyboard })
        await ctx.answerCallbackQuery()
      } catch (error) {
        await ctx.answerCallbackQuery({ text: `Could not load models: ${reason(error)}`, show_alert: true }).catch(() => {})
      }
      return true
    }

    if (cb.kind === 'antigravity-model') {
      pruneAntigravitySelections()
      const selection = antigravityModelSelections.get(cb.token)
      if (!selection) {
        await ctx.answerCallbackQuery({ text: 'This model picker expired. Run /model again.' }).catch(() => {})
        return true
      }
      if (selection.topic !== currentTopic || !antigravityService.isLocked(selection.topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return true
      }
      const keyboard = new InlineKeyboard()
      for (const effort of selection.model.efforts) {
        const suffix = effort === selection.model.defaultEffort ? ' · default' : ''
        keyboard.text(`${effort}${suffix}`, encodeCallback({ kind: 'antigravity-effort', token: cb.token, effort })).row()
      }
      keyboard.text('Back', encodeCallback({ kind: 'antigravity-models', topic: selection.topic, page: 0 }))
      await ctx.editMessageText(`${selection.model.label}: choose reasoning effort`, {
        reply_markup: keyboard,
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (cb.kind === 'antigravity-effort') {
      pruneAntigravitySelections()
      const selection = antigravityModelSelections.get(cb.token)
      const effort = cb.effort
      if (!selection || !selection.model.efforts.includes(effort)) {
        await ctx.answerCallbackQuery({ text: 'This effort picker expired. Run /model again.' }).catch(() => {})
        return true
      }
      if (selection.topic !== currentTopic || !antigravityService.isLocked(selection.topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return true
      }
      const result = await antigravityService.requestRoute(
        selection.topic,
        antigravityRoute(selection.model, effort),
      )
      const changed = result.topic
      antigravityModelSelections.delete(cb.token)
      await ctx.editMessageText(
        `${result.pending ? 'Switch queued for the next idle boundary:' : 'Now using'} ${antigravityRouteLabel(result.pending ? antigravityRoute(selection.model, effort) : changed.route)} ` +
        `in the same Antigravity conversation (${changed.conversationId ?? 'starts on your first message'}).\n\n` +
        'This topic remains harness-locked; Anthropic, Codex, and OpenCode routes are unavailable here.',
      ).catch(() => {})
      await ctx.answerCallbackQuery({ text: result.pending ? 'Model queued.' : 'Model updated in Herdr.' }).catch(() => {})
      return true
    }

    if (cb.kind === 'antigravity-usage') {
      const topic = cb.topic
      if (topic !== currentTopic || !antigravityService.isLocked(topic)) {
        await ctx.answerCallbackQuery({ text: 'This picker belongs to another topic.', show_alert: true }).catch(() => {})
        return true
      }
      try {
        const usage = antigravityUsageText(await refreshAntigravityUsage(true))
        await ctx.editMessageText(usage, {
          reply_markup: new InlineKeyboard().text('Back', encodeCallback({ kind: 'antigravity-models', topic, page: 0 })),
        })
        await ctx.answerCallbackQuery()
      } catch (error) {
        await ctx.answerCallbackQuery({ text: `Could not read usage: ${reason(error)}`, show_alert: true }).catch(() => {})
      }
      return true
    }
    return false
  }

  const harness: TopicHarnessAdapter = {
    kind: 'antigravity',
    lockCommand: ANTIGRAVITY_RE,
    attachments: 'eager',
    tracesInbound: false,
    owns: topic => antigravityService.isLocked(topic),
    lock: c => activateAntigravityTopic(c.chatId, c.topic, c.fromId),
    model: (c, argument) => handleAntigravityModelCommand(c.chatId, c.topic, c.fromId, argument),
    usage: async ({ chatId, topic }) => {
      try {
        await sayIn(chatId, topic, antigravityUsageText(await refreshAntigravityUsage(true)))
      } catch (error) {
        await sayIn(chatId, topic, `Could not read Antigravity usage: ${reason(error)}`)
      }
    },
    relaunch: async ({ chatId, topic }) => {
      const current = antigravityService.get(topic)!
      const result = await antigravityService.requestRelaunch(topic)
      await sayIn(
        chatId,
        topic,
        result.pending
          ? `Antigravity is busy; relaunch is queued for the next idle boundary. It will keep conversation ` +
            `${current.conversationId ?? 'not started'} and reopen in Herdr.`
          : `Relaunched Antigravity in Herdr with the same conversation ` +
            `${result.topic.conversationId ?? 'not started'} and freshly loaded MCP/configuration.`,
      )
    },
    rename: (topic, name) => antigravityService.rename(topic, name),
    receive: async ({ topic }, turn) => {
      log(`received Antigravity Telegram turn ${turn.messageId ?? '(no id)'} for topic ${topic}`)
      void antigravityService.submitTurn(topic, { content: turn.content, meta: turn.meta })
        .then(() => log(`settled Antigravity Telegram turn ${turn.messageId ?? '(no id)'} for topic ${topic}`))
    },
    sent: (topic, messages) =>
      log(`sent Antigravity Telegram reply for topic ${topic} (${messages} message${messages === 1 ? '' : 's'})`),
    prepareTopic: async name => {
      // Resolved before Telegram creates the topic: a catalog or auth failure must not strand an empty one.
      const route = await defaultAntigravityRoute()
      return async topic => {
        antigravityService.activate(antigravityTopic(topic, name, route))
        await antigravityService.start(topic)
      }
    },
    reconcile: () => antigravityService.reconcilePending(),
  }

  return { harness, refreshUsage: refreshAntigravityUsage, handleCallback }
}
