import type { TopicRoute } from '../domain/model-routing'

export function effectiveClaudeSettings(
  base: Record<string, unknown>,
  route: TopicRoute,
): Record<string, unknown> {
  return {
    ...structuredClone(base),
    ultracode: route.ultracode,
  }
}
