import { expect, test } from 'bun:test'
import type { ProviderCatalog } from '../../routing/provider-catalog'
import { routeChoice } from './route-choice'

const opus = { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh'] as const, defaultEffort: 'xhigh' as const, supportsUltracode: true }
const catalog: ProviderCatalog = {
  anthropic: [{ ...opus, efforts: [...opus.efforts] }, { id: 'haiku', label: 'Haiku', efforts: ['low'], defaultEffort: 'low' }],
  codex: [{ id: 'gpt-old', label: 'Old', efforts: ['medium'], defaultEffort: 'medium', bridgeSupported: false }],
  'opencode-go': [],
}

test('a listed model with one of its efforts is a choice; no effort means its default', () => {
  expect(routeChoice(catalog, { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' }, false))
    .toMatchObject({ provider: 'anthropic', model: { id: 'claude-opus-5-5' }, effort: 'high', ultracode: false })
  expect(routeChoice(catalog, { provider: 'anthropic', model: 'claude-opus-5-5' }, false)).toMatchObject({ effort: 'xhigh' })
})

test('Ultracode stays as the topic has it, where the model supports it', () => {
  expect(routeChoice(catalog, { provider: 'anthropic', model: 'claude-opus-5-5' }, true)).toMatchObject({ ultracode: true })
  expect(routeChoice(catalog, { provider: 'anthropic', model: 'haiku' }, true)).toMatchObject({ ultracode: false })
})

test('an unknown provider, an unlisted or unrunnable model, or an effort the model lacks is refused by name', () => {
  const code = (body: unknown) => (routeChoice(catalog, body, false) as { code?: string }).code
  expect(code({ provider: 'gemini', model: 'x' })).toBe('bad_provider')
  expect(code({ provider: 'anthropic', model: 'nope' })).toBe('bad_model')
  expect(code({ provider: 'codex', model: 'gpt-old' })).toBe('bad_model')
  expect(code({ provider: 'anthropic', model: 'haiku', effort: 'xhigh' })).toBe('bad_effort')
  expect(code(null)).toBe('bad_provider')
})
