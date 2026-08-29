export const PROVIDERS = ['anthropic', 'codex', 'opencode-go'] as const

export type ProviderId = (typeof PROVIDERS)[number]
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RouteChangeReason = 'manual' | 'quota' | 'reset' | 'migration'

export type TopicRoute = {
  provider: ProviderId
  model: string
  effort: Effort
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
  effort: 'xhigh',
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)
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
}): TopicRoute {
  return {
    provider: input.provider,
    model: normalizeModel(input.provider, input.model),
    effort: input.effort ?? defaultEffort(input.provider),
  }
}

export function defaultEffort(provider: ProviderId): Effort {
  if (provider === 'opencode-go') return 'medium'
  return 'xhigh'
}

export function sameRoute(left: TopicRoute, right: TopicRoute): boolean {
  return left.provider === right.provider && left.model === right.model && left.effort === right.effort
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
