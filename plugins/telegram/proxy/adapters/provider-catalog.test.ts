import { describe, expect, test } from 'bun:test'
import { catalogFromBridge, parseBridgeModels } from './provider-catalog'

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
})
