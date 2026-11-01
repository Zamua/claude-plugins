// A topic's route through providers and models: what it runs on, a change waiting for the turn to end, the routes
// that hit their limits, and the nudge a resumed session owes. Only nextRoute changes it; routing/routing.ts and the
// turn-boundary callers are the shell that observes, sends events and performs the effects.
import {
  exhaustedRouteFor,
  forgetExhaustedProvider,
  launchModel,
  modelLabel,
  planRouteChange,
  providerLabel,
  quotaFallbackRoute,
  quotaReturnRoute,
  rememberExhaustedRoute,
  retainsExhaustedRoute,
  sameRoute,
} from './model-routing'
import type { PendingRouteChange, ProviderId, RouteChangeReason, TopicRoute } from './model-routing'

/** An operator's change, or a report, this soon after the last change is treated as belonging to it. */
export const ROUTE_DEBOUNCE_MS = 10_000

export type RouteFlow = {
  route: TopicRoute
  /** A change requested mid-turn, applied when the turn ends. */
  pending?: PendingRouteChange
  /** Per provider, the route that last hit its limit, kept so its reset can offer it back. */
  exhausted: TopicRoute[]
  /** Tells the next resumed session to answer the message a limit swallowed; cleared once delivered. */
  resumeNotice?: string
  /** When the operator or a quota fallback last changed the route. Not persisted. */
  changedAt?: number
}

export type RouteEvent =
  /** The operator picked a route (`byOperator`), or a reset or migration asks for one. */
  | { type: 'requested'; route: TopicRoute; reason: RouteChangeReason; busy: boolean; byOperator: boolean; now: number }
  /** The operator pressed "switch back" for a provider whose limit was recorded. */
  | { type: 'switch-back'; provider: ProviderId; busy: boolean; limitedProviders: ProviderId[]; now: number }
  /** The running turn ended: a poll, or an idle pane. */
  | { type: 'turn-ended' }
  /**
   * The topic's Claude reported a usage limit. `ranOn` is the provider and model it says it ran as; `limitedProviders`
   * are those whose capacity reads as exhausted; `resetAt` is when the limit lifts, if the report said.
   */
  | {
    type: 'rate-limited'
    ranOn?: { provider: string; model: string }
    agentRunning: boolean
    limitedProviders: ProviderId[]
    resetAt?: number
    now: number
  }
  /** The resumed session received the resume notice. */
  | { type: 'notice-delivered' }
  /** A live session restored at boot runs an older launch profile; refresh it at the next turn boundary. */
  | { type: 'profile-stale'; now: number }

export type RouteEffect =
  | { type: 'stop-agent' }
  /** Start the agent on the new route and pump its pane. */
  | { type: 'start-agent' }
  /** A change was queued; a proxied pane's pump should look for the turn boundary soon. */
  | { type: 'await-boundary' }
  | { type: 'save' }
  | { type: 'announce-fallback'; limited: TopicRoute; fallback: TopicRoute; resetAt?: number }
  | { type: 'announce-limit'; limited: TopicRoute; resetAt?: number }

export type RouteOutcome =
  | 'unchanged'
  | 'applied'
  | 'queued'
  /** Ignored: another change ran moments ago. */
  | 'too-soon'
  /** A switch-back with nothing recorded to return to. */
  | 'nothing-to-return'
  /** A switch-back to a provider still at its limit. */
  | 'still-limited'
  /** A limit report from a process a change already replaced, or repeating one already handled. */
  | 'duplicate'
  | 'fell-back'
  | 'stopped-at-limit'
  | 'none'

export type RouteStep = {
  flow: RouteFlow
  effects: RouteEffect[]
  outcome: RouteOutcome
  /** The route that is now running and why, when this step applied one. */
  applied?: { from: TopicRoute; to: TopicRoute; reason: RouteChangeReason }
}

export function recoveryNotice(from: TopicRoute, to: TopicRoute): string {
  return (
    `SYSTEM NOTICE (not a user message): the previous turn failed because ${providerLabel(from.provider)} ` +
    `${modelLabel(from.model)} reached its usage limit. This same Claude Code session has resumed through ${providerLabel(to.provider)} ` +
    `on ${modelLabel(to.model)}, with the full conversation intact. Continue where you left off and answer ` +
    `the user's most recent unanswered message now. Mention the provider switch only if it affects the answer.`
  )
}

const none = (flow: RouteFlow): RouteStep => ({ flow, effects: [], outcome: 'none' })

export function nextRoute(flow: RouteFlow, event: RouteEvent): RouteStep {
  switch (event.type) {
    case 'requested': {
      if (event.byOperator && tooSoon(flow, event.now)) return { flow, effects: [], outcome: 'too-soon' }
      const marked = event.byOperator ? { ...flow, changedAt: event.now } : flow
      return request(marked, event.route, event.reason, event.busy, event.now)
    }
    case 'switch-back':
      return switchBack(flow, event)
    case 'turn-ended':
      return flow.pending ? apply(flow, flow.pending.route, flow.pending.reason) : none(flow)
    case 'rate-limited':
      return rateLimited(flow, event)
    case 'notice-delivered': {
      if (!flow.resumeNotice) return none(flow)
      const { resumeNotice: _delivered, ...rest } = flow
      return { flow: rest, effects: [{ type: 'save' }], outcome: 'none' }
    }
    case 'profile-stale':
      // A change already queued restarts the session anyway
      if (flow.pending) return none(flow)
      return { flow: { ...flow, pending: { route: flow.route, reason: 'migration', requestedAt: event.now } }, effects: [], outcome: 'queued' }
    default: {
      const unhandled: never = event
      throw new Error(`unhandled route event ${JSON.stringify(unhandled)}`)
    }
  }
}

const tooSoon = (flow: RouteFlow, now: number) => now - (flow.changedAt ?? 0) < ROUTE_DEBOUNCE_MS

function request(flow: RouteFlow, route: TopicRoute, reason: RouteChangeReason, busy: boolean, now: number): RouteStep {
  const plan = planRouteChange(flow.route, route, reason, busy ? 'busy' : 'idle', now)
  switch (plan.kind) {
    case 'unchanged':
      return { flow, effects: [], outcome: 'unchanged' }
    case 'apply-now':
      return apply(flow, plan.route, plan.reason)
    case 'wait-for-turn-boundary':
      return {
        flow: {
          ...flow,
          pending: plan.pending,
          ...(reason === 'quota' && { resumeNotice: recoveryNotice(flow.exhausted.at(-1) ?? flow.route, route) }),
        },
        effects: [{ type: 'save' }, { type: 'await-boundary' }],
        outcome: 'queued',
      }
    default: {
      const unhandled: never = plan
      throw new Error(`unhandled route plan ${JSON.stringify(unhandled)}`)
    }
  }
}

// Stops whatever runs, switches, and starts again on the same conversation. A quota change owes the resumed session
// a notice; a reset, or a choice other than the automatic fallback, forgets that provider's recorded limit.
function apply(flow: RouteFlow, route: TopicRoute, reason: RouteChangeReason): RouteStep {
  const from = flow.route
  const recorded = exhaustedRouteFor(flow.exhausted, route.provider)
  const forget = reason === 'reset' || (!!recorded && !retainsExhaustedRoute(recorded, route, reason))
  const { pending: _replaced, ...rest } = flow
  return {
    flow: {
      ...rest,
      route,
      exhausted: forget ? forgetExhaustedProvider(flow.exhausted, route.provider) : flow.exhausted,
      ...(reason === 'quota' && { resumeNotice: recoveryNotice(flow.exhausted.at(-1) ?? from, route) }),
    },
    effects: [{ type: 'stop-agent' }, { type: 'save' }, { type: 'start-agent' }],
    outcome: 'applied',
    applied: { from, to: route, reason },
  }
}

function switchBack(flow: RouteFlow, event: Extract<RouteEvent, { type: 'switch-back' }>): RouteStep {
  const route = exhaustedRouteFor(flow.exhausted, event.provider)
  if (!route) return { flow, effects: [], outcome: 'nothing-to-return' }
  if (event.limitedProviders.includes(event.provider)) return { flow, effects: [], outcome: 'still-limited' }
  if (tooSoon(flow, event.now)) return { flow, effects: [], outcome: 'too-soon' }
  const step = request({ ...flow, changedAt: event.now }, route, 'reset', event.busy, event.now)
  if (step.outcome !== 'unchanged') return step
  return {
    flow: { ...step.flow, exhausted: forgetExhaustedProvider(step.flow.exhausted, event.provider) },
    effects: [{ type: 'save' }],
    outcome: 'unchanged',
  }
}

function rateLimited(flow: RouteFlow, event: Extract<RouteEvent, { type: 'rate-limited' }>): RouteStep {
  const limited = flow.route
  const returnRoute = quotaReturnRoute(flow.exhausted, limited)
  const alreadyReported = exhaustedRouteFor(flow.exhausted, limited.provider)
  // A report naming another route than the topic's came from a process a change already replaced. A hook that names
  // none leaves only the clock.
  const fromReplaced = event.ranOn
    ? event.ranOn.provider !== limited.provider || event.ranOn.model !== launchModel(limited)
    : tooSoon(flow, event.now)
  // Stopped at the end of the chain, a second report repeats the one that stopped it
  const repeated = !event.agentRunning && !!alreadyReported && sameRoute(alreadyReported, returnRoute)
  if (fromReplaced || repeated) return { flow, effects: [], outcome: 'duplicate' }

  const { pending: _dropped, ...rest } = flow
  const fallback = quotaFallbackRoute(limited)
  if (fallback && !event.limitedProviders.includes(fallback.provider)) {
    const recorded = { ...rest, exhausted: rememberExhaustedRoute(flow.exhausted, limited), changedAt: event.now }
    const step = apply(recorded, fallback, 'quota')
    return {
      ...step,
      effects: [...step.effects, { type: 'announce-fallback', limited, fallback, ...(event.resetAt !== undefined && { resetAt: event.resetAt }) }],
      outcome: 'fell-back',
    }
  }
  return {
    flow: { ...rest, exhausted: rememberExhaustedRoute(flow.exhausted, returnRoute) },
    effects: [
      { type: 'stop-agent' },
      { type: 'save' },
      { type: 'announce-limit', limited, ...(event.resetAt !== undefined && { resetAt: event.resetAt }) },
    ],
    outcome: 'stopped-at-limit',
  }
}
