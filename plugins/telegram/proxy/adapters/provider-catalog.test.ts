import { describe, expect, test } from 'bun:test'
import { catalogFromBridge, parseBridgeModels, parseOpenCodeModels } from './provider-catalog'

const output = [
  'codex: fable, gpt-5.6-sol, gpt-5.6-sol-fast, opus',
  'opencode: glm-5.2, opencode-go/glm-5.2, opencode-go/kimi-k3',
].join('\n')

describe('provider catalog adapter', () => {
  test('parses compact bridge model output', () => {
    expect(parseBridgeModels(output).get('codex')).toEqual([
      'fable', 'gpt-5.6-sol', 'gpt-5.6-sol-fast', 'opus',
    ])
  })

  test('keeps only provider-qualified OpenCode models', () => {
    const catalog = catalogFromBridge(output)
    expect(catalog['opencode-go'].map(model => model.id)).toEqual([
      'opencode-go/glm-5.2', 'opencode-go/kimi-k3',
    ])
  })

  test('intersects Codex account models with bridge support', () => {
    const account = [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'high'] as const, defaultEffort: 'high' as const },
      { id: 'gpt-9', label: 'GPT-9', efforts: ['high'] as const, defaultEffort: 'high' as const },
    ].map(model => ({ ...model, efforts: [...model.efforts] }))
    expect(catalogFromBridge(output, account).codex.map(model => model.id)).toEqual(['gpt-5.6-sol'])
  })

  test('adds OpenCode effort and context metadata from the installed catalog', () => {
    const modelList = JSON.stringify({
      data: [
        {
          providerID: 'opencode-go',
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          limit: { context: 1_000_000 },
          variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }],
        },
        { providerID: 'opencode-go', id: 'kimi-k2.6', name: 'Kimi K2.6', limit: { context: 262_144 }, variants: [] },
        { providerID: 'opencode', id: 'big-pickle', name: 'Big Pickle', limit: { context: 200_000 }, variants: [] },
      ],
    })
    const metadata = parseOpenCodeModels(modelList)
    const bridge = 'opencode: opencode-go/deepseek-v4-flash, opencode-go/kimi-k2.6'
    const models = catalogFromBridge(bridge, undefined, metadata)['opencode-go']

    expect(models).toEqual([
      {
        id: 'opencode-go/deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        contextWindow: 1_000_000,
        supportsUltracode: true,
      },
      {
        id: 'opencode-go/kimi-k2.6',
        label: 'Kimi K2.6',
        efforts: ['auto'],
        defaultEffort: 'auto',
        contextWindow: 262_144,
        supportsUltracode: false,
      },
    ])
  })

  test('unreadable model list output yields no metadata', () => {
    expect(parseOpenCodeModels('opencode-go/glm-5.3').size).toBe(0)
  })

  test('shows newly installed models even before the bridge learns them', () => {
    const metadata = parseOpenCodeModels(JSON.stringify({
      data: [{
        providerID: 'opencode-go', id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', limit: { context: 1_000_000 },
        variants: [{ id: 'none' }, { id: 'high' }],
      }],
    }))
    expect(catalogFromBridge('opencode: opencode-go/glm-5.2', undefined, metadata)['opencode-go']).toEqual([
      {
        id: 'opencode-go/glm-5.3-flash',
        label: 'GLM-5.3 Flash',
        efforts: ['high'],
        defaultEffort: 'high',
        contextWindow: 1_000_000,
        supportsUltracode: true,
        bridgeSupported: false,
      },
    ])
  })
})
