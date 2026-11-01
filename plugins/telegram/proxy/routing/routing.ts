// Provider/model routing below the Claude harness: the /model picker, quota
// failover and switch-back, provider capacity and its reset timers. Every route
// runs the same Claude conversation; a change restarts it with a new launch profile.
import { execFileSync } from 'child_process'
import type { Api, Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import {
  ADMIN_USER_ID,
  DEFAULT_TOPIC_ROUTE,
  GROUP_CHAT_ID,
  OPENCODE_BIN,
  OPENCODE_GO_KEY_FILE,
  PROVIDER_PROXY_BIN,
  SQUARE_TOPIC,
} from '../config'
import { parseRateLimit, parseTurnFailed } from '../http/requests'
import { json } from '../http/response'
import { log, noticeFailed } from '../log'
import { inboundModeForRoute } from '../shared/domain/inbound-delivery'
import {
  encodeCallback,
  formatTime,
  legacySwitchBack,
  MODELS_PER_PAGE,
  PICKER_TTL_MS,
} from '../telegram/telegram-callback'
import type { Callback } from '../telegram/telegram-callback'
import { threadIdForTopic, threadOf } from '../telegram/telegram-messages'
import { mux } from '../topics/mux'
import { saveRegistry } from '../topics/registry'
import { currentRoute, getTopic, topics } from '../topics/state'
import type { TopicState } from '../topics/state'
import { readCodexSnapshot } from './codex-app-server'
import {
  autoCompactWindow,
  auxiliaryModelForRoute,
  exhaustedRouteFor,
  forgetExhaustedProvider,
  modelLabel,
  planRouteChange,
  providerLabel,
  quotaFallbackRoute,
  quotaReturnRoute,
  rememberExhaustedRoute,
  retainsExhaustedRoute,
  sameRoute,
  topicRoute,
} from './domain/model-routing'
import type { Effort, PickerReason, ProviderId, RouteChangeReason, TopicRoute } from './domain/model-routing'
import { capacityTransition, nextResetAt, providerCapacity } from './domain/provider-capacity'
import type { ProviderCapacity } from './domain/provider-capacity'
import { readOpenCodeGoCapacity } from './opencode-go-capacity'
import { permissionNotice } from './permission-notice'
import { launchModel } from '../topics/claude-launch'
import { sessionOf } from '../topics/domain/agent'
import { catalogFromBridge, parseOpenCodeModels } from './provider-catalog'
import type { ProviderCatalog, ProviderModel } from './provider-catalog'

export type RoutingPorts = {
  api: Api
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  /** Stops a topic's agent and drops its long-polls, so nothing is handed to the dying process. */
  killSession: (st: TopicState, topic: string) => boolean
  ensureSession: (topic: string) => void
  schedulePanePump: (topic: string, delayMs?: number) => void
  /** True while a proxied topic's pane holds a turn the proxy typed into it. */
  paneInFlight: (topic: string) => boolean
}

export function createRouting({ api, sayIn, killSession, ensureSession, schedulePanePump, paneInFlight }: RoutingPorts) {
  const ROUTE_DEBOUNCE_MS = 10_000
  const lastRouteChange = new Map<string, number>()

  const capacities = new Map<ProviderId, ProviderCapacity>()
  type ModelSelection = {
    topic: string
    provider: ProviderId
    model: ProviderModel
    reason: PickerReason
    expiresAt: number
    effort?: Effort
  }
  const modelSelections = new Map<string, ModelSelection>()
  let catalogCache: { value: ProviderCatalog; at: number } | undefined
  let codexAccountModels: ProviderModel[] | undefined
  const resetTimers = new Map<ProviderId, ReturnType<typeof setTimeout>>()

  function modelCatalog(): ProviderCatalog {
    if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.value
    let bridgeOutput = ''
    let openCodeModels = new Map<string, ProviderModel>()
    try {
      bridgeOutput = execFileSync(PROVIDER_PROXY_BIN, ['models'], { encoding: 'utf8', timeout: 15_000 })
    } catch (e) {
      log(`provider bridge model catalog failed: ${e}`)
    }
    try {
      const output = execFileSync(OPENCODE_BIN, ['api', 'model.list'], {
        encoding: 'utf8', timeout: 20_000,
      })
      openCodeModels = parseOpenCodeModels(output)
    } catch (e) {
      log(`OpenCode model metadata failed: ${e}`)
    }
    const value = catalogFromBridge(bridgeOutput, codexAccountModels, openCodeModels)
    catalogCache = { value, at: Date.now() }
    return value
  }

  function routeSummary(route: TopicRoute): string {
    return `${providerLabel(route.provider)} · ${modelLabel(route.model)} · ${route.effort} · ` +
      `Ultracode ${route.ultracode ? 'on' : 'off'}`
  }

  function auxiliaryModel(route: TopicRoute): string {
    return auxiliaryModelForRoute(
      route,
      modelCatalog()[route.provider]
        .filter(model => model.bridgeSupported !== false)
        .map(model => model.id),
    )
  }

  function executionPolicySummary(route: TopicRoute): string {
    const effort = route.effort === 'auto' ? 'provider default' : `${route.effort} enforced`
    return [
      `Subagents: ${modelLabel(route.model)} · ${effort}`,
      `Auxiliary: ${modelLabel(auxiliaryModel(route))}`,
      `Workflow: ${route.ultracode ? 'enabled' : 'blocked'}`,
    ].join('\n')
  }

  function providerKeyboard(topic: string, reason: PickerReason, exclude?: ProviderId): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    const providers: ProviderId[] = ['anthropic', 'codex', 'opencode-go']
    for (const provider of providers.filter(value => value !== exclude)) {
      const availability = capacities.get(provider)?.availability
      const suffix = availability === 'exhausted' ? ' · limit reached' : availability === 'available' ? ' · available' : ''
      keyboard.text(`${providerLabel(provider)}${suffix}`, encodeCallback({ kind: 'provider', provider, reason, topic })).row()
    }
    keyboard.text('Usage', encodeCallback({ kind: 'usage', topic }))
    return keyboard
  }

  async function sendProviderPicker(
    chatId: string,
    topic: string,
    reason: PickerReason,
    text: string,
    exclude?: ProviderId,
  ): Promise<void> {
    await api.sendMessage(chatId, text, {
      ...threadOf(topic),
      reply_markup: providerKeyboard(topic, reason, exclude),
    }).catch(e => log(`provider picker failed for topic ${topic}: ${e}`))
  }

  function modelToken(selection: ModelSelection): string {
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    modelSelections.set(token, selection)
    return token
  }

  function pruneModelSelections(): void {
    const now = Date.now()
    for (const [token, selection] of modelSelections) {
      if (selection.expiresAt < now) modelSelections.delete(token)
    }
  }

  function modelPicker(
    topic: string,
    provider: ProviderId,
    reason: PickerReason,
    page: number,
  ): { text: string; keyboard: InlineKeyboard } {
    pruneModelSelections()
    const models = modelCatalog()[provider]
    const pages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE))
    const safePage = Math.max(0, Math.min(page, pages - 1))
    const keyboard = new InlineKeyboard()
    for (const model of models.slice(safePage * MODELS_PER_PAGE, (safePage + 1) * MODELS_PER_PAGE)) {
      const token = modelToken({ topic, provider, model, reason, expiresAt: Date.now() + PICKER_TTL_MS })
      keyboard.text(`${model.label}${model.bridgeSupported === false ? ' · bridge update needed' : ''}`, encodeCallback({ kind: 'model', token })).row()
    }
    if (pages > 1) {
      if (safePage > 0) {
        keyboard.text('Previous', encodeCallback({ kind: 'models', provider, reason, topic, page: safePage - 1 }))
      }
      if (safePage + 1 < pages) {
        keyboard.text('Next', encodeCallback({ kind: 'models', provider, reason, topic, page: safePage + 1 }))
      }
      keyboard.row()
    }
    keyboard.text('Back', encodeCallback({ kind: 'providers', reason, topic }))
    return {
      text: models.length
        ? `${providerLabel(provider)} models${pages > 1 ? ` (${safePage + 1}/${pages})` : ''}:` + permissionNotice(provider)
        : `${providerLabel(provider)} model catalog is temporarily unavailable. Go back and try again.`,
      keyboard,
    }
  }

  function topicRuntime(topic: string, st: TopicState): 'idle' | 'busy' {
    const session = sessionOf(st.agent)
    if (!session || !mux.liveSessions().has(session)) return 'idle'
    if (inboundModeForRoute(currentRoute(st)) === 'pane') {
      if (paneInFlight(topic)) return 'busy'
      return mux.runtime(session) === 'idle' ? 'idle' : 'busy'
    }
    if (st.waiters.length > 0) return 'idle'
    return 'busy'
  }

  function recoveryNotice(from: TopicRoute, to: TopicRoute): string {
    return (
      `SYSTEM NOTICE (not a user message): the previous turn failed because ${providerLabel(from.provider)} ` +
      `${modelLabel(from.model)} reached its usage limit. This same Claude Code session has resumed through ${providerLabel(to.provider)} ` +
      `on ${modelLabel(to.model)}, with the full conversation intact. Continue where you left off and answer ` +
      `the user's most recent unanswered message now. Mention the provider switch only if it affects the answer.`
    )
  }

  function applyRouteNow(topic: string, route: TopicRoute, reason: RouteChangeReason): void {
    const st = getTopic(topic)
    const from = currentRoute(st)
    killSession(st, topic)
    st.route = route
    st.pendingRoute = undefined
    if (reason === 'quota') {
      const exhausted = st.exhaustedRoutes.at(-1) ?? from
      st.pendingResumeNotice = recoveryNotice(exhausted, route)
    }
    const recorded = exhaustedRouteFor(st.exhaustedRoutes, route.provider)
    if (reason === 'reset' || (recorded && !retainsExhaustedRoute(recorded, route, reason))) {
      st.exhaustedRoutes = forgetExhaustedProvider(st.exhaustedRoutes, route.provider)
    }
    saveRegistry()
    ensureSession(topic)
    schedulePanePump(topic)
    log(`topic ${topic} route applied: ${routeSummary(from)} -> ${routeSummary(route)} (${reason})`)
  }

  function requestRouteChange(topic: string, route: TopicRoute, reason: RouteChangeReason): 'unchanged' | 'applied' | 'queued' {
    const st = getTopic(topic)
    const plan = planRouteChange(currentRoute(st), route, reason, topicRuntime(topic, st), Date.now())
    if (plan.kind === 'unchanged') return 'unchanged'
    if (plan.kind === 'wait-for-turn-boundary') {
      st.pendingRoute = plan.pending
      if (reason === 'quota') {
        st.pendingResumeNotice = recoveryNotice(st.exhaustedRoutes.at(-1) ?? currentRoute(st), route)
      }
      saveRegistry()
      if (inboundModeForRoute(currentRoute(st)) === 'pane') schedulePanePump(topic, 250)
      return 'queued'
    }
    applyRouteNow(topic, plan.route, plan.reason)
    return 'applied'
  }

  async function handleModelCommand(chatId: string, topic: string, fromId: string, arg: string): Promise<void> {
    if (SQUARE_TOPIC && topic === SQUARE_TOPIC) {
      await sayIn(chatId, topic, 'The square has no Claude session of its own. Run /model in a topic.')
      return
    }
    if (!ADMIN_USER_ID || fromId !== ADMIN_USER_ID) {
      await sayIn(chatId, topic, 'Only the operator can change provider or model routes.')
      return
    }
    const value = arg.trim().toLowerCase()
    if (value === 'status') {
      const st = getTopic(topic)
      const route = currentRoute(st)
      await sayIn(
        chatId,
        topic,
        `Claude session: ${st.claudeSessionId ?? 'not started'}\n` +
        `Route: ${routeSummary(route)}\n${executionPolicySummary(route)}`,
      )
      return
    }
    const requestedProvider = value === 'chatgpt' || value === 'codex'
      ? 'codex'
      : value === 'opencode' || value === 'opencode-go'
        ? 'opencode-go'
        : value === 'anthropic' || value === 'claude'
          ? 'anthropic'
          : undefined
    if (requestedProvider) {
      const picker = modelPicker(topic, requestedProvider, 'manual', 0)
      await api.sendMessage(chatId, picker.text, { ...threadOf(topic), reply_markup: picker.keyboard })
        .catch(noticeFailed('model picker', topic))
      return
    }
    const route = currentRoute(getTopic(topic))
    await sendProviderPicker(chatId, topic, 'manual', `Current route: ${routeSummary(route)}\n\nChoose a provider:`)
  }

  function capacityText(): string {
    const lines: string[] = []
    for (const provider of ['anthropic', 'codex', 'opencode-go'] as ProviderId[]) {
      const capacity = capacities.get(provider)
      if (!capacity) {
        lines.push(`${providerLabel(provider)}: usage not observed yet`)
        continue
      }
      const windows = capacity.windows.map(window => {
        const used = window.usedPercent == null ? window.availability : `${window.usedPercent}% used`
        return `${window.name}: ${used}${window.resetsAt ? `, resets ${formatTime(window.resetsAt)}` : ''}`
      })
      lines.push(`${providerLabel(provider)}: ${capacity.availability}\n  ${windows.join('\n  ')}`)
      if (capacity.resetCredits) lines.push(`  ${capacity.resetCredits} reset credit(s) available`)
    }
    return `Provider usage\n\n${lines.join('\n\n')}`
  }

  function switchBackKeyboard(topic: string, route: TopicRoute): InlineKeyboard {
    return new InlineKeyboard()
      .text(`Switch back to ${modelLabel(route.model)}`, encodeCallback({ kind: 'switch-back', provider: route.provider, topic }))
      .row()
      .text(`Choose ${providerLabel(route.provider)} model`, encodeCallback({ kind: 'provider', provider: route.provider, reason: 'reset', topic }))
      .row()
      .text('Dismiss', encodeCallback({ kind: 'dismiss' }))
  }

  async function applySwitchBackCallback(ctx: any, provider: ProviderId, topic: string): Promise<void> {
    const st = getTopic(topic)
    const route = exhaustedRouteFor(st.exhaustedRoutes, provider)
    if (!route) {
      await ctx.answerCallbackQuery({ text: 'This switch-back was already handled or is no longer available.' }).catch(() => {})
      return
    }
    if (capacities.get(provider)?.availability === 'exhausted') {
      await ctx.answerCallbackQuery({
        text: `${providerLabel(provider)} is still at its usage limit.`,
        show_alert: true,
      }).catch(() => {})
      return
    }
    const since = Date.now() - (lastRouteChange.get(topic) ?? 0)
    if (since < ROUTE_DEBOUNCE_MS) {
      await ctx.answerCallbackQuery({ text: 'A route change just ran. Wait a moment.' }).catch(() => {})
      return
    }
    lastRouteChange.set(topic, Date.now())
    const result = requestRouteChange(topic, route, 'reset')
    if (result === 'unchanged') {
      st.exhaustedRoutes = forgetExhaustedProvider(st.exhaustedRoutes, provider)
      saveRegistry()
    }
    const text = result === 'queued'
      ? `Queued ${routeSummary(route)}. It will switch when the current Claude turn finishes.`
      : result === 'unchanged'
        ? `Already using ${routeSummary(route)}.`
        : `Now using ${routeSummary(route)} in the same Claude session.`
    await ctx.editMessageText(text + permissionNotice(route.provider)).catch((error: unknown) =>
      log(`could not update switch-back message for topic ${topic}: ${error}`))
    await ctx.answerCallbackQuery({ text: result === 'queued' ? 'Switch queued.' : 'Route updated.' }).catch(() => {})
    log(`switch-back callback for topic ${topic}: ${provider}/${route.model} (${result})`)
  }

  async function notifyProviderReset(provider: ProviderId): Promise<void> {
    for (const [topic, st] of topics) {
      const route = exhaustedRouteFor(st.exhaustedRoutes, provider)
      if (!route) continue
      await api.sendMessage(
        String(GROUP_CHAT_ID),
        `${providerLabel(provider)} is available again. This topic switched away after its limit was reached.`,
        { ...threadOf(topic), reply_markup: switchBackKeyboard(topic, route) },
      ).catch(e => log(`reset notice failed for ${provider} topic ${topic}: ${e}`))
    }
  }

  function scheduleCapacityReset(capacity: ProviderCapacity): void {
    const existing = resetTimers.get(capacity.provider)
    if (existing) clearTimeout(existing)
    const at = nextResetAt(capacity)
    if (!at || capacity.availability !== 'exhausted') return
    const delay = Math.min(Math.max(1000, at - Date.now() + 1000), 2_147_000_000)
    resetTimers.set(capacity.provider, setTimeout(() => {
      const current = capacities.get(capacity.provider)
      if (!current) return
      const now = Date.now()
      const windows = current.windows.map(window =>
        window.resetsAt && window.resetsAt <= now
          ? { ...window, usedPercent: 0, availability: 'available' as const }
          : window,
      )
      observeCapacity(providerCapacity(capacity.provider, windows, now, current.resetCredits))
    }, delay))
  }

  function observeCapacity(capacity: ProviderCapacity): void {
    const previous = capacities.get(capacity.provider)
    capacities.set(capacity.provider, capacity)
    scheduleCapacityReset(capacity)
    if (capacityTransition(previous, capacity) === 'reset') void notifyProviderReset(capacity.provider)
  }

  async function refreshProviderCapacity(): Promise<void> {
    const [codex, opencode] = await Promise.allSettled([
      readCodexSnapshot(),
      readOpenCodeGoCapacity(OPENCODE_GO_KEY_FILE, () =>
        execFileSync(OPENCODE_BIN, ['auth', 'export'], { encoding: 'utf8', timeout: 20_000 })),
    ])
    if (codex.status === 'fulfilled') {
      codexAccountModels = codex.value.models
      catalogCache = undefined
      observeCapacity(codex.value.capacity)
    } else {
      log(`Codex capacity probe failed: ${codex.reason}`)
    }
    if (opencode.status === 'fulfilled') observeCapacity(opencode.value)
    else log(`OpenCode Go capacity probe failed: ${opencode.reason}`)
  }

  // POST /rate-limit {topic, error, details, reset_at}. The failed user turn is
  // already in Claude's transcript. A route with an automatic quota fallback
  // resumes the same Claude UUID on that fallback; any other route stops and
  // Telegram offers another provider. Either way the resumed session receives a
  // one-time nudge to finish that turn.
  async function handleRateLimit(req: Request): Promise<Response> {
    const b = parseRateLimit(await req.json())
    const topic = b.topic
    const st = getTopic(topic)
    const label = st.name || topic
    const limitedRoute = st.route ?? DEFAULT_TOPIC_ROUTE
    const returnRoute = quotaReturnRoute(st.exhaustedRoutes, limitedRoute)
    const alreadyReported = exhaustedRouteFor(st.exhaustedRoutes, limitedRoute.provider)
    // A report naming another route than the topic's came from a process a route
    // change already replaced. A hook that names none leaves only the clock.
    const fromReplaced = b.ranOn
      ? b.ranOn.provider !== limitedRoute.provider || b.ranOn.model !== launchModel(limitedRoute)
      : Date.now() - (lastRouteChange.get(topic) ?? 0) < ROUTE_DEBOUNCE_MS
    if (fromReplaced || (st.agent.state !== 'running' && alreadyReported && sameRoute(alreadyReported, returnRoute))) {
      return json({ ok: true, provider: limitedRoute.provider, awaiting_selection: true, duplicate: true })
    }
    const resetMs = b.resetAt !== undefined && b.resetAt * 1000 > Date.now()
      ? b.resetAt * 1000
      : undefined
    const resetText = resetMs ? `\nExpected reset: ${formatTime(resetMs)}.` : ''

    const fallback = quotaFallbackRoute(limitedRoute)
    if (fallback && capacities.get(fallback.provider)?.availability !== 'exhausted') {
      st.exhaustedRoutes = rememberExhaustedRoute(st.exhaustedRoutes, limitedRoute)
      st.pendingRoute = undefined
      killSession(st, topic)
      saveRegistry()
      lastRouteChange.set(topic, Date.now())
      const result = requestRouteChange(topic, fallback, 'quota')
      log(`rate limit on topic ${topic} "${label}" for ${limitedRoute.provider}/${limitedRoute.model}; ` +
        `fell back to ${routeSummary(fallback)} (${result})`)
      await api.sendMessage(
        String(GROUP_CHAT_ID),
        `${modelLabel(limitedRoute.model)} reached its usage limit.${resetText}\n` +
          `This session continues on ${routeSummary(fallback)}.`,
        { ...threadOf(topic), reply_markup: switchBackKeyboard(topic, limitedRoute) },
      ).catch(e => log(`quota fallback notice failed for topic ${topic}: ${e}`))
      if (resetMs) scheduleFallbackReturnOffer(topic, limitedRoute, fallback, resetMs)
      return json({ ok: true, provider: limitedRoute.provider, fallback, awaiting_selection: false })
    }

    observeCapacity(providerCapacity(limitedRoute.provider, [{
      name: 'current window',
      usedPercent: 100,
      availability: 'exhausted',
      ...(resetMs ? { resetsAt: resetMs } : {}),
    }], Date.now()))
    st.exhaustedRoutes = rememberExhaustedRoute(st.exhaustedRoutes, returnRoute)
    st.pendingRoute = undefined
    killSession(st, topic)
    saveRegistry()
    log(`rate limit on topic ${topic} "${label}" for ${limitedRoute.provider}/${limitedRoute.model}`)
    await sendProviderPicker(
      String(GROUP_CHAT_ID),
      topic,
      'quota',
      `${providerLabel(limitedRoute.provider)} · ${modelLabel(limitedRoute.model)} reached its usage limit.` +
        resetText +
        `\n\nContinue this same Claude session with:`,
      limitedRoute.provider,
    )
    return json({ ok: true, provider: limitedRoute.provider, awaiting_selection: true })
  }

  // A model-scoped limit never marks the provider exhausted, so provider capacity
  // cannot announce its reset; offer the way back at the reported reset instead.
  function scheduleFallbackReturnOffer(topic: string, limited: TopicRoute, fallback: TopicRoute, resetMs: number): void {
    const delay = Math.min(Math.max(1000, resetMs - Date.now() + 1000), 2_147_000_000)
    setTimeout(() => {
      const st = getTopic(topic)
      const recorded = exhaustedRouteFor(st.exhaustedRoutes, limited.provider)
      if (!recorded || !sameRoute(recorded, limited) || !sameRoute(currentRoute(st), fallback)) return
      api.sendMessage(
        String(GROUP_CHAT_ID),
        `${modelLabel(limited.model)} should be available again.`,
        { ...threadOf(topic), reply_markup: switchBackKeyboard(topic, limited) },
      ).catch(e => log(`fallback return offer failed for topic ${topic}: ${e}`))
    }, delay)
  }

  // POST /capacity is fed by the Claude status-line adapter. External-provider
  // capacity is probed directly by their infrastructure adapters.
  async function handleCapacity(req: Request): Promise<Response> {
    const body = (await req.json()) as any
    if (body?.provider !== 'anthropic' || !Array.isArray(body?.windows)) {
      return new Response('invalid capacity payload', { status: 400 })
    }
    const windows = body.windows.flatMap((raw: any) => {
      const availability = raw?.availability
      if (!['available', 'exhausted', 'unknown'].includes(availability)) return []
      const usedPercent = Number(raw.used_percent)
      const resetsAt = Number(raw.resets_at)
      return [{
        name: String(raw.name ?? 'window'),
        ...(Number.isFinite(usedPercent) ? { usedPercent } : {}),
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        availability,
      }]
    })
    observeCapacity(providerCapacity('anthropic', windows, Date.now()))
    return json({ ok: true })
  }

  // POST /turn-failed {topic, error, details} - a topic-Claude's turn died on a
  // non-rate-limit API error (529 overloaded, 5xx, auth...). Reported by the
  // StopFailure hook. The failed turn already consumed the user's message, so
  // without a notice the session just looks like it silently ignored them
  // (observed 2026-07-29 during an Anthropic overload incident). Notify-only:
  // model switching would not fix these, and the notice rides Telegram's API,
  // which survives an Anthropic outage. No debounce by operator choice - keep
  // it simple; revisit if an incident ever makes this spammy.
  async function handleTurnFailed(req: Request): Promise<Response> {
    const { topic, error: err, details } = parseTurnFailed(await req.json())
    // CONTEXT OVERFLOW, not a fault: the harness classifies an invalid_request
    // carrying this language as "request too large" and responds by
    // auto-compacting, then carries on. Same regex the CLI uses, so we stay in
    // step with it. Reporting these as errors was alarming for a routine,
    // self-healing event (2026-07-31: a long hostthis session tripped it three
    // times).
    const overflow = /\b(too long|too large|exceeds|token limit)\b/i.test(details)
    const overloaded = /overload/i.test(err) || /529/.test(details)
    const st = getTopic(topic)
    const tid = threadIdForTopic(topic)
    const text = overflow
      ? `🗜️ Context filled up, so I'm auto-compacting and carrying on - normal housekeeping, ` +
        `nothing broken. If I go quiet for more than a minute or two, resend your last message.`
      : overloaded
        ? `⚠️ My last turn failed: Anthropic is overloaded (529) - server-side, usually temporary ` +
          `(status.claude.com). Your last message may be unanswered - resend it or say "continue".`
        : `⚠️ My last turn failed with an API error (${err}). Your last message may be unanswered - ` +
          `resend it or say "continue".`
    try {
      await api.sendMessage(String(GROUP_CHAT_ID), text, {
        ...(tid != null ? { message_thread_id: tid } : {}),
      })
      log(`turn-failed notice posted for topic ${topic} "${st.name}" (${err}${overflow ? ', context-overflow/compacting' : ''})`)
      return json({ ok: true })
    } catch (e) {
      log(`turn-failed notice FAILED for topic ${topic}: ${e}`)
      return new Response('send failed', { status: 502 })
    }
  }


  // The route pickers' and switch-back buttons; true when the callback was one of them.
  async function handleRouteCallback(ctx: Context, cb: Callback): Promise<boolean> {
    if (cb.kind === 'switch-back') {
      await applySwitchBackCallback(ctx, cb.provider, cb.topic)
      return true
    }

    if (cb.kind === 'provider' || cb.kind === 'models') {
      const { provider, reason, topic } = cb
      const page = cb.kind === 'models' ? cb.page : 0
      if (capacities.get(provider)?.availability === 'exhausted') {
        await ctx.answerCallbackQuery({
          text: `${providerLabel(provider)} is still at its usage limit. Use /usage for the reset time.`,
          show_alert: true,
        }).catch(() => {})
        return true
      }
      const picker = modelPicker(topic, provider, reason, page)
      await ctx.editMessageText(picker.text, { reply_markup: picker.keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (cb.kind === 'providers') {
      const { reason, topic } = cb
      const st = getTopic(topic)
      const exclude = reason === 'quota' ? st.exhaustedRoutes.at(-1)?.provider : undefined
      await ctx.editMessageText('Choose a provider:', {
        reply_markup: providerKeyboard(topic, reason, exclude),
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (cb.kind === 'model') {
      pruneModelSelections()
      const selection = modelSelections.get(cb.token)
      if (!selection) {
        const legacy = legacySwitchBack(ctx.callbackQuery?.message)
        if (legacy) {
          await applySwitchBackCallback(ctx, legacy.provider, legacy.topic)
          return true
        }
        await ctx.answerCallbackQuery({ text: 'This model picker expired. Run /model again.' }).catch(() => {})
        return true
      }
      if (capacities.get(selection.provider)?.availability === 'exhausted') {
        await ctx.answerCallbackQuery({
          text: `${providerLabel(selection.provider)} is still at its usage limit.`,
          show_alert: true,
        }).catch(() => {})
        return true
      }
      if (selection.model.bridgeSupported === false) {
        await ctx.answerCallbackQuery({
          text: `${selection.model.label} is installed but this bridge build cannot route it yet.`,
          show_alert: true,
        }).catch(() => {})
        return true
      }
      const keyboard = new InlineKeyboard()
      for (const effort of selection.model.efforts) {
        const label = effort === 'auto' ? 'Provider default' : effort
        const suffix = effort === selection.model.defaultEffort ? ' · default' : ''
        keyboard.text(`${label}${suffix}`, encodeCallback({ kind: 'effort', token: cb.token, effort })).row()
      }
      await ctx.editMessageText(`${selection.model.label}: choose reasoning effort`, {
        reply_markup: keyboard,
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (cb.kind === 'effort') {
      pruneModelSelections()
      const selection = modelSelections.get(cb.token)
      const effort = cb.effort
      if (!selection || !selection.model.efforts.includes(effort)) {
        await ctx.answerCallbackQuery({ text: 'This effort picker expired.' }).catch(() => {})
        return true
      }
      selection.effort = effort
      const keyboard = new InlineKeyboard().text('Off', encodeCallback({ kind: 'ultracode', token: cb.token, on: false })).row()
      if (selection.model.supportsUltracode) {
        keyboard.text('On · forces xhigh + workflows', encodeCallback({ kind: 'ultracode', token: cb.token, on: true })).row()
      }
      const compact = autoCompactWindow(selection.provider, selection.model.contextWindow)
      await ctx.editMessageText(
        `${selection.model.label} · ${effort === 'auto' ? 'provider-default effort' : `${effort} effort`}\n` +
        `Auto-compaction: ${compact ? `${compact.toLocaleString()} tokens` : 'provider-managed'}\n\n` +
        (selection.model.supportsUltracode
          ? 'Choose Ultracode. Turning it on overrides effort to xhigh and enables dynamic workflows.'
          : 'Ultracode is not supported by this model; choose Off.'),
        { reply_markup: keyboard },
      ).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (cb.kind === 'ultracode') {
      pruneModelSelections()
      const selection = modelSelections.get(cb.token)
      const ultracode = cb.on
      if (!selection || !selection.effort) {
        await ctx.answerCallbackQuery({ text: 'This model picker expired. Run /model again.' }).catch(() => {})
        return true
      }
      if (ultracode && !selection.model.supportsUltracode) {
        await ctx.answerCallbackQuery({ text: 'Ultracode is not supported by this model.', show_alert: true }).catch(() => {})
        return true
      }
      if (capacities.get(selection.provider)?.availability === 'exhausted') {
        await ctx.answerCallbackQuery({
          text: `${providerLabel(selection.provider)} is still at its usage limit.`,
          show_alert: true,
        }).catch(() => {})
        return true
      }
      const since = Date.now() - (lastRouteChange.get(selection.topic) ?? 0)
      if (since < ROUTE_DEBOUNCE_MS) {
        await ctx.answerCallbackQuery({ text: 'A route change just ran. Wait a moment.' }).catch(() => {})
        return true
      }
      lastRouteChange.set(selection.topic, Date.now())
      const route = topicRoute({
        provider: selection.provider,
        model: selection.model.id,
        effort: selection.effort,
        ultracode,
      })
      const result = requestRouteChange(selection.topic, route, selection.reason)
      modelSelections.delete(cb.token)
      await ctx.editMessageText(
        (result === 'queued'
          ? `Queued ${routeSummary(route)}. It will switch when the current Claude turn finishes.`
          : result === 'unchanged'
            ? `Already using ${routeSummary(route)}.`
            : `Now using ${routeSummary(route)} in the same Claude session.`) +
        permissionNotice(route.provider) +
        (result === 'unchanged' && route.provider === 'codex'
          ? '\nRun /relaunch to apply the launch settings to this existing session.' : ''),
      ).catch(() => {})
      await ctx.answerCallbackQuery({ text: result === 'queued' ? 'Switch queued.' : 'Route updated.' }).catch(() => {})
      return true
    }

    if (cb.kind === 'usage') {
      await refreshProviderCapacity()
      await ctx.editMessageText(capacityText(), {
        reply_markup: new InlineKeyboard().text('Back', encodeCallback({ kind: 'providers', reason: 'manual', topic: cb.topic })),
      }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    if (cb.kind === 'dismiss') {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
      await ctx.answerCallbackQuery({ text: 'Dismissed.' }).catch(() => {})
      return true
    }
    return false
  }

  return {
    modelCatalog,
    applyRouteNow,
    handleModelCommand,
    capacityText,
    refreshProviderCapacity,
    handleRateLimit,
    handleCapacity,
    handleTurnFailed,
    handleRouteCallback,
  }
}
