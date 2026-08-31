import type { ProviderId } from '../domain/model-routing'

export type SwitchBackTarget = { provider: ProviderId; topic: string }

function providerFromCode(code: string): ProviderId | undefined {
  return code === 'a' ? 'anthropic' : code === 'c' ? 'codex' : code === 'o' ? 'opencode-go' : undefined
}

export function switchBackTarget(data: string): SwitchBackTarget | undefined {
  const match = /^tgroute:return:([aco]):(.+)$/.exec(data)
  const provider = match ? providerFromCode(match[1]) : undefined
  return match && provider ? { provider, topic: match[2] } : undefined
}

export function legacySwitchBackTarget(message: unknown): SwitchBackTarget | undefined {
  const rows = (message as any)?.reply_markup?.inline_keyboard
  if (!Array.isArray(rows)) return undefined
  for (const button of rows.flat()) {
    const match = /^tgroute:p:([aco]):r:(.+)$/.exec(String(button?.callback_data ?? ''))
    const provider = match ? providerFromCode(match[1]) : undefined
    if (match && provider) return { provider, topic: match[2] }
  }
  return undefined
}
