// A route the app asks for, checked against the model catalog the picker offers.
import { PROVIDERS } from '../../routing/domain/model-routing'
import type { Effort, ProviderId } from '../../routing/domain/model-routing'
import type { ProviderCatalog } from '../../routing/provider-catalog'
import type { RouteChoice } from '../../routing/routing'

export type ChoiceRefusal = { code: string; message: string }

/** Models the bridge cannot run are listed nowhere and chosen never. */
export const offered = (catalog: ProviderCatalog, provider: ProviderId) =>
  catalog[provider].filter(model => model.bridgeSupported !== false)

/**
 * The provider, model and effort the body names. No effort means the model's
 * default. Ultracode is kept as the topic has it, where the model supports it,
 * since the app has no control for it.
 */
export function routeChoice(catalog: ProviderCatalog, body: unknown, ultracode: boolean): RouteChoice | ChoiceRefusal {
  const { provider, model, effort } = (body ?? {}) as { provider?: unknown; model?: unknown; effort?: unknown }
  if (!PROVIDERS.includes(provider as ProviderId)) return { code: 'bad_provider', message: `provider must be one of ${PROVIDERS.join(', ')}` }
  const found = offered(catalog, provider as ProviderId).find(m => m.id === model)
  if (!found) return { code: 'bad_model', message: 'model must be one GET /v1/routes lists for that provider' }
  const chosen = effort === undefined || effort === null ? found.defaultEffort : effort
  if (!found.efforts.includes(chosen as Effort)) return { code: 'bad_effort', message: `effort must be one of ${found.efforts.join(', ')}` }
  return { provider: provider as ProviderId, model: found, effort: chosen as Effort, ultracode: ultracode && found.supportsUltracode === true }
}
