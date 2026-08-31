import { describe, expect, test } from 'bun:test'
import { legacySwitchBackTarget, switchBackTarget } from './telegram-route-callback'

describe('Telegram switch-back callbacks', () => {
  test('decodes a stateless switch-back callback', () => {
    expect(switchBackTarget('tgroute:return:c:1133')).toEqual({ provider: 'codex', topic: '1133' })
    expect(switchBackTarget('tgroute:return:o:general')).toEqual({ provider: 'opencode-go', topic: 'general' })
    expect(switchBackTarget('tgroute:m:expired')).toBeUndefined()
  })

  test('recovers the provider and topic from a pre-deployment reset keyboard', () => {
    const message = {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Switch back to GPT-5.6 Sol', callback_data: 'tgroute:m:deadbeef' }],
          [{ text: 'Choose ChatGPT / Codex model', callback_data: 'tgroute:p:c:r:2308' }],
        ],
      },
    }
    expect(legacySwitchBackTarget(message)).toEqual({ provider: 'codex', topic: '2308' })
    expect(legacySwitchBackTarget({ reply_markup: { inline_keyboard: [] } })).toBeUndefined()
  })
})
