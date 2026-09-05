export const PROVIDERS = ['anthropic', 'codex', 'opencode-go'] as const

export type ProviderId = (typeof PROVIDERS)[number]
export type Effort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RouteChangeReason = 'manual' | 'quota' | 'reset' | 'migration'

export type TopicRoute = {
  provider: ProviderId
  model: string
  effort: Effort
  ultracode: boolean
}

export type PendingRouteChange = {
  route: TopicRoute
  reason: RouteChangeReason
  requestedAt: number
}

export type RouteChangePlan =
  | { kind: 'unchanged'; route: TopicRoute }
  | { kind: 'apply-now'; route: TopicRoute; reason: RouteChangeReason }
  | { kind: 'wait-for-turn-boundary'; pending: PendingRouteChange }

export const DEFAULT_ROUTE: TopicRoute = {
  provider: 'anthropic',
  model: 'fable',
  effort: 'medium',
  ultracode: false,
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
}

export function normalizeModel(provider: ProviderId, model: string): string {
  const value = model.trim()
  if (!value) throw new Error('model is required')

  if (provider === 'codex') {
    if (!value.startsWith('gpt-')) throw new Error(`invalid Codex model: ${value}`)
    return value
  }

  if (provider === 'opencode-go') {
    return value.startsWith('opencode-go/') ? value : `opencode-go/${value}`
  }

  return value
}

export function topicRoute(input: {
  provider: ProviderId
  model: string
  effort?: Effort
  ultracode?: boolean
}): TopicRoute {
  const ultracode = input.ultracode ?? false
  return {
    provider: input.provider,
    model: normalizeModel(input.provider, input.model),
    effort: ultracode ? 'xhigh' : input.effort ?? defaultEffort(input.provider, input.model),
    ultracode,
  }
}

export function topicRouteFromRecord(value: unknown): TopicRoute | undefined {
  const raw = value as Record<string, unknown> | null
  if (!raw || !isProviderId(raw.provider) || typeof raw.model !== 'string') return undefined
  try {
    const legacyRoute = !Object.prototype.hasOwnProperty.call(raw, 'ultracode')
    const legacySolXhigh = legacyRoute && raw.provider === 'codex' &&
      raw.model === 'gpt-5.6-sol' && raw.effort === 'xhigh'
    return topicRoute({
      provider: raw.provider,
      model: raw.model,
      effort: legacySolXhigh ? 'medium' : isEffort(raw.effort) ? raw.effort : undefined,
      ultracode: legacyRoute ? false : raw.ultracode === true,
    })
  } catch {
    return undefined
  }
}

export function defaultEffort(provider: ProviderId, model?: string): Effort {
  if (provider === 'opencode-go') return 'auto'
  if (provider === 'anthropic' && model === 'fable') return 'medium'
  return 'xhigh'
}

const AUXILIARY_MODEL_PREFERENCES: Record<ProviderId, readonly string[]> = {
  anthropic: ['haiku'],
  codex: ['gpt-5.6-luna'],
  'opencode-go': [
    'opencode-go/gpt-5.6-luna',
    'opencode-go/glm-5.3-flash',
    'opencode-go/deepseek-v4-flash',
  ],
}

// Auxiliary traffic must stay inside the selected provider's allowance. Prefer
// that provider's efficient model, but fall back to the selected main model if
// the installed/account catalog does not currently expose one of our choices.
export function auxiliaryModelForRoute(
  route: TopicRoute,
  availableModels: readonly string[],
): string {
  const available = new Set(availableModels)
  return AUXILIARY_MODEL_PREFERENCES[route.provider].find(model => available.has(model)) ?? route.model
}

export function sameRoute(left: TopicRoute, right: TopicRoute): boolean {
  return left.provider === right.provider && left.model === right.model &&
    left.effort === right.effort && left.ultracode === right.ultracode
}

// Claude Code accepts explicit compaction thresholds from 100k through 1m.
// Native Anthropic owns its context accounting. Codex deliberately compacts at
// its long-context billing boundary; OpenCode follows installed model metadata.
export function autoCompactWindow(provider: ProviderId, contextWindow?: number): number | undefined {
  if (provider === 'anthropic') return undefined
  if (provider === 'codex') return 272_000
  if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return 200_000
  return Math.max(100_000, Math.min(1_000_000, Math.floor(contextWindow!)))
}

// A topic may exhaust more than one provider while continuing the same
// conversation. Keep the most recent route per provider so every later reset
// can offer an exact switch-back choice without losing earlier providers.
export function rememberExhaustedRoute(routes: TopicRoute[], exhausted: TopicRoute): TopicRoute[] {
  return [...routes.filter(route => route.provider !== exhausted.provider), exhausted]
}

export function exhaustedRouteFor(routes: TopicRoute[], provider: ProviderId): TopicRoute | undefined {
  return routes.findLast(route => route.provider === provider)
}

export function forgetExhaustedProvider(routes: TopicRoute[], provider: ProviderId): TopicRoute[] {
  return routes.filter(route => route.provider !== provider)
}

export function planRouteChange(
  current: TopicRoute,
  requested: TopicRoute,
  reason: RouteChangeReason,
  runtime: 'idle' | 'busy',
  now: number,
): RouteChangePlan {
  if (sameRoute(current, requested)) return { kind: 'unchanged', route: current }
  if (runtime === 'idle') return { kind: 'apply-now', route: requested, reason }
  return {
    kind: 'wait-for-turn-boundary',
    pending: { route: requested, reason, requestedAt: now },
  }
}

export function providerLabel(provider: ProviderId): string {
  if (provider === 'anthropic') return 'Anthropic'
  if (provider === 'codex') return 'ChatGPT / Codex'
  return 'OpenCode Go'
}

export function modelLabel(model: string): string {
  return model.replace(/^opencode-go\//, '')
}
