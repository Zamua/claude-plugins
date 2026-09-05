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
  { id: 'fable', label: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', supportsUltracode: true },
  { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh', supportsUltracode: true },
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsUltracode: false },
  { id: 'haiku', label: 'Haiku', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsUltracode: false },
]

const CLAUDE_EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'xhigh', 'max'])

export function parseOpenCodeModels(output: string): Map<string, ProviderModel> {
  const models = new Map<string, ProviderModel>()
  const chunks = output.split(/(?=^opencode-go\/[^\s]+\s*$)/m)
  for (const chunk of chunks) {
    const lines = chunk.trim().split('\n')
    const header = /^opencode-go\/([^\s]+)$/.exec(lines[0]?.trim() ?? '')
    if (!header) continue
    const jsonStart = lines.findIndex(line => line.trim().startsWith('{'))
    if (jsonStart < 0) continue
    try {
      const raw = JSON.parse(lines.slice(jsonStart).join('\n'))
      const id = `opencode-go/${String(raw?.id ?? header[1])}`
      const efforts = Object.entries(raw?.variants ?? {}).flatMap(([name, value]: [string, any]) => {
        const declared = String(value?.reasoningEffort ?? value?.effort ?? name)
        return CLAUDE_EFFORTS.has(declared as Effort) ? [declared as Effort] : []
      })
      const uniqueEfforts = [...new Set(efforts)]
      const selectableEfforts: Effort[] = uniqueEfforts.length ? uniqueEfforts : ['auto']
      const defaultEffort: Effort = selectableEfforts.includes('medium')
        ? 'medium'
        : selectableEfforts.includes('high') ? 'high' : selectableEfforts[0]
      const context = Number(raw?.limit?.context)
      const bridgeSupportsXhigh = /^opencode-go\/deepseek-v4/.test(id) ||
        /^opencode-go\/glm-5\.[23]/.test(id) || id === 'opencode-go/kimi-k3'
      models.set(id, {
        id,
        label: String(raw?.name ?? header[1]),
        efforts: selectableEfforts,
        defaultEffort,
        ...(Number.isFinite(context) && context > 0 ? { contextWindow: context } : {}),
        supportsUltracode: selectableEfforts.includes('xhigh') || bridgeSupportsXhigh,
      })
    } catch {}
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
