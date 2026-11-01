import { describe, expect, test } from 'bun:test'
import { ANTIGRAVITY_DISABLED_MESSAGE, DisabledAntigravityRuntime } from './disabled-antigravity-runtime'

describe('disabled Antigravity runtime', () => {
  const runtime = new DisabledAntigravityRuntime()
  const spec = {
    topic: '1',
    name: 'pilot',
    sessionName: 'agy-pilot-1',
    route: { modelVariant: 'gemini-3.8-flash-high', effort: 'high' as const },
    kickoff: 'hello',
  }

  test('rejects every catalog and session operation with the disabled message', async () => {
    await expect(runtime.models()).rejects.toThrow(ANTIGRAVITY_DISABLED_MESSAGE)
    await expect(runtime.usage()).rejects.toThrow(ANTIGRAVITY_DISABLED_MESSAGE)
    await expect(runtime.ensureSession(spec)).rejects.toThrow(ANTIGRAVITY_DISABLED_MESSAGE)
    await expect(runtime.prompt('agy-pilot-1', 'hi')).rejects.toThrow(ANTIGRAVITY_DISABLED_MESSAGE)
  })

  test('reports sessions as missing and stops nothing', async () => {
    expect(await runtime.status('agy-pilot-1')).toBe('missing')
    expect(await runtime.stop('agy-pilot-1')).toBe(false)
  })
})
