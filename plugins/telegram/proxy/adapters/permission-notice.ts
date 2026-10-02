import type { ProviderId } from '../domain/model-routing'

export function permissionNotice(provider: ProviderId): string {
  return provider === 'codex'
    ? '\n\nChatGPT models bypass permission checks. Tool actions, including file changes and shell commands, can run without approval prompts.'
    : ''
}
