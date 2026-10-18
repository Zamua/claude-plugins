import type { Effort, ProviderId } from '../domain/model-routing'

export type ProviderModel = {
  id: string
  label: string
  efforts: Effort[]
  defaultEffort: Effort
  contextWindow?: number
  supportsUltracode?: boolean
  bridgeSupported?: boolean
}

export type ProviderCatalog = Record<ProviderId, ProviderModel[]>

const CLAUDE_MODELS: ProviderModel[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh', supportsUltracode: true },
  { id: 'fable', label: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', supportsUltracode: true },
  { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh', supportsUltracode: true },
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', supportsUltracode: false },
  { id: 'haiku', label: 'Haiku', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsUltracode: false },
]

const CLAUDE_EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'xhigh', 'max'])

// Reads `opencode api model.list`: {data: [{providerID, id, name, limit, variants: [{id}]}]}.
export function parseOpenCodeModels(output: string): Map<string, ProviderModel> {
  const models = new Map<string, ProviderModel>()
  let entries: any[] = []
  try {
    entries = JSON.parse(output)?.data ?? []
  } catch {
    return models
  }
  for (const raw of entries) {
    if (raw?.providerID !== 'opencode-go' || !raw?.id) continue
    const id = `opencode-go/${String(raw.id)}`
    const efforts = (Array.isArray(raw.variants) ? raw.variants : [])
      .map((variant: any) => String(variant?.id ?? ''))
      .filter((name: string): name is Effort => CLAUDE_EFFORTS.has(name as Effort))
    const uniqueEfforts = [...new Set<Effort>(efforts)]
    const selectableEfforts: Effort[] = uniqueEfforts.length ? uniqueEfforts : ['auto']
    const defaultEffort: Effort = selectableEfforts.includes('medium')
      ? 'medium'
      : selectableEfforts.includes('high') ? 'high' : selectableEfforts[0]
    const context = Number(raw.limit?.context)
    const bridgeSupportsXhigh = /^opencode-go\/deepseek-v4/.test(id) ||
      /^opencode-go\/glm-5\.[23]/.test(id) || id === 'opencode-go/kimi-k3'
    models.set(id, {
      id,
      label: String(raw.name ?? raw.id),
      efforts: selectableEfforts,
      defaultEffort,
      ...(Number.isFinite(context) && context > 0 ? { contextWindow: context } : {}),
      supportsUltracode: selectableEfforts.includes('xhigh') || bridgeSupportsXhigh,
    })
  }
  return models
}

export function parseBridgeModels(output: string): Map<string, string[]> {
  const providers = new Map<string, string[]>()
  for (const line of output.split('\n')) {
    const match = /^([a-z0-9-]+):\s*(.+)$/i.exec(line.trim())
    if (!match) continue
    providers.set(match[1], match[2].split(',').map(value => value.trim()).filter(Boolean))
  }
  return providers
}

export function catalogFromBridge(
  output: string,
  codexAccountModels?: ProviderModel[],
  openCodeModels = new Map<string, ProviderModel>(),
): ProviderCatalog {
  const parsed = parseBridgeModels(output)
  const codexSupported = new Set((parsed.get('codex') ?? []).filter(id => id.startsWith('gpt-')))
  const codexSource = codexAccountModels ?? [...codexSupported].map(id => ({
    id,
    label: id,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as Effort[],
    defaultEffort: id === 'gpt-5.6-sol' ? 'medium' as Effort : 'xhigh' as Effort,
    supportsUltracode: true,
  }))
  const codex = codexSource.filter(model => codexSupported.has(model.id))

  const opencodeSupported = new Set(
    (parsed.get('opencode') ?? []).filter(id => id.startsWith('opencode-go/')),
  )
  const opencode = openCodeModels.size
    ? [...openCodeModels.values()].map(model => opencodeSupported.has(model.id)
      ? model
      : { ...model, bridgeSupported: false })
    : [...opencodeSupported].map(id => ({
      id,
      label: id.replace(/^opencode-go\//, ''),
      efforts: ['auto'] as Effort[],
      defaultEffort: 'auto' as Effort,
      supportsUltracode: false,
    }))

  return { anthropic: CLAUDE_MODELS, codex, 'opencode-go': opencode }
}
