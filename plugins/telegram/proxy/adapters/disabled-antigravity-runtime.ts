import type {
  AntigravityRuntimePort,
  AntigravitySessionIdentity,
  AntigravitySessionStatus,
  AntigravityUsageWindow,
} from '../application/antigravity-ports'
import type { AntigravityModel } from '../domain/antigravity-topic'

export const ANTIGRAVITY_DISABLED_MESSAGE =
  'Antigravity is disabled on this proxy (TELEGRAM_ANTIGRAVITY=off).'

// Stands in for the Herdr runtime when the integration is switched off. It never
// spawns agy: an unauthenticated agy opens a browser sign-in on every call.
export class DisabledAntigravityRuntime implements AntigravityRuntimePort {
  async models(): Promise<AntigravityModel[]> {
    throw new Error(ANTIGRAVITY_DISABLED_MESSAGE)
  }

  async usage(): Promise<AntigravityUsageWindow[]> {
    throw new Error(ANTIGRAVITY_DISABLED_MESSAGE)
  }

  async status(_sessionName: string): Promise<AntigravitySessionStatus> {
    return 'missing'
  }

  async ensureSession(): Promise<AntigravitySessionIdentity> {
    throw new Error(ANTIGRAVITY_DISABLED_MESSAGE)
  }

  async prompt(_sessionName: string, _prompt: string): Promise<void> {
    throw new Error(ANTIGRAVITY_DISABLED_MESSAGE)
  }

  async stop(_sessionName: string): Promise<boolean> {
    return false
  }
}
