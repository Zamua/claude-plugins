import { sameRoute, topicRouteFromRecord } from './model-routing'
import type { TopicRoute } from './model-routing'

export function launchProfileNeedsRefresh(
  persistedVersion: number | undefined,
  currentVersion: number,
  persistedRoute: unknown,
  currentRoute: TopicRoute,
): boolean {
  if (persistedVersion !== currentVersion) return true
  const raw = persistedRoute as Record<string, unknown> | null
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'ultracode')) return true
  const parsed = topicRouteFromRecord(raw)
  return !parsed || !sameRoute(parsed, currentRoute)
}
