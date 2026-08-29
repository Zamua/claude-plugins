import type { Effort, ProviderId } from '../domain/model-routing'

export type ProviderModel = {
  id: string
  label: string
  efforts: Effort[]
  defaultEffort: Effort
}

export type ProviderCatalog = Record<ProviderId, ProviderModel[]>

const CLAUDE_MODELS: ProviderModel[] = [
  { id: 'fable', label: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh' },
  { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh' },
  { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  { id: 'haiku', label: 'Haiku', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
]

export function parseBridgeModels(output: string): Map<string, string[]> {
  const providers = new Map<string, string[]>()
  for (const line of output.split('\n')) {
    const match = /^([a-z0-9-]+):\s*(.+)$/i.exec(line.trim())
    if (!match) continue
    providers.set(match[1], match[2].split(',').map(value => value.trim()).filter(Boolean))
  }
  return providers
}

export function catalogFromBridge(output: string, codexAccountModels?: ProviderModel[]): ProviderCatalog {
  const parsed = parseBridgeModels(output)
  const codexSupported = new Set((parsed.get('codex') ?? []).filter(id => id.startsWith('gpt-')))
  const codexSource = codexAccountModels ?? [...codexSupported].map(id => ({
    id,
    label: id,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as Effort[],
    defaultEffort: 'xhigh' as Effort,
  }))
  const codex = codexSource.filter(model => codexSupported.has(model.id))

  const opencode = (parsed.get('opencode') ?? [])
    .filter(id => id.startsWith('opencode-go/'))
    .map(id => ({
      id,
      label: id.replace(/^opencode-go\//, ''),
      efforts: ['medium'] as Effort[],
      defaultEffort: 'medium' as Effort,
    }))

  return { anthropic: CLAUDE_MODELS, codex, 'opencode-go': opencode }
}
