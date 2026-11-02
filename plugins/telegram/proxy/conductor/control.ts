// The operator's commands from the app: a route switch, relaunch, interrupt,
// usage, and creating, renaming, pinning and muting topics. Each runs through the same routing and lifecycle Telegram's
// verbs use, and an act that changes a topic is echoed into it, so Telegram
// stays the full record.
import type { ProviderCapacity } from '../routing/domain/provider-capacity'
import type { ProviderCatalog } from '../routing/provider-catalog'
import type { RouteChoice, RouteRefusal, RouteRequest } from '../routing/routing'
import { InvalidReminder } from '../reminders/domain/reminder'
import type { Reminder, ReminderRequest } from '../reminders/domain/reminder'
import { nameError, SecretExists, SecretMissing } from '../secrets/secret'
import type { SecretEntry, StoredSecret } from '../secrets/secret'
import { tilde } from '../log'
import { bypassesPermissions } from '../routing/domain/model-routing'
import { routeChoice } from './domain/route-choice'
import { topicName, topicPatch } from './domain/topic-edit'
import { wireReminder, wireRoutes, wireSecrets, wireUsage } from './wire'

export type ControlResult =
  | { ok: Record<string, unknown> }
  | { refused: { status: 400 | 403 | 404 | 409 | 429 | 500 | 502 | 503; code: string; message: string } }

/** Who asked for a route change: the app (a signed device) or the unauthenticated loopback API. */
export type RouteOrigin = 'app' | 'loopback'

const ECHO: Record<RouteOrigin, string> = { app: 'You (app)', loopback: 'Crook backend' }

export type ControlPorts = {
  catalog: () => ProviderCatalog
  capacities: () => readonly ProviderCapacity[]
  refreshCapacity: () => Promise<void>
  usageText: () => string
  /** Whether the topic runs with Ultracode now. */
  ultracode: (topic: string) => boolean
  requestRoute: (topic: string, choice: RouteChoice) => RouteRequest
  routeChangeText: (request: Extract<RouteRequest, { outcome: unknown }>) => string
  /** Why a topic takes no agent commands (the square), or none. */
  noAgent: (topic: string) => string | undefined
  /** Why a topic takes no route or interrupt (a locked harness), or none. */
  locked: (topic: string) => string | undefined
  relaunch: (topic: string) => Promise<void>
  /** Presses the agent's stop key; false when it is not running. */
  interrupt: (topic: string) => boolean
  /** Posts into the topic's chat. */
  say: (topic: string, text: string) => Promise<void>
  /** Posts the operator's own act into the topic's chat, without notifying them of it. */
  echo: (topic: string, text: string) => Promise<void>
  /** Creates a Claude topic in the chat and the proxy; gives its id. */
  createTopic: (name: string) => Promise<string>
  /** Renames the chat's topic and the proxy's record of it. */
  renameTopic: (topic: string, name: string) => Promise<void>
  /** The app's own pin and mute. */
  setPrefs: (topic: string, prefs: { pinned?: boolean; muted?: boolean }) => void
  /** Whether a topic is one the app lists. */
  listed: (topic: string) => boolean
  secretsOn: () => boolean
  listSecrets: () => SecretEntry[]
  storeSecret: (name: string, value: string, replace: boolean, topic?: string) => Promise<StoredSecret>
  deleteSecret: (name: string, topic?: string) => Promise<{ bytes: number }>
  topicReminders: (topic: string) => Reminder[]
  addReminder: (request: ReminderRequest) => Reminder
  cancelReminder: (id: string) => Reminder | undefined
}

/** A secret's value is at most this many bytes, as a drop's message would be. */
const SECRET_MAX_BYTES = 64 * 1024

export const COMMANDS = [
  { name: 'relaunch', description: "restart this topic's agent, same conversation", args_hint: null },
  { name: 'interrupt', description: 'stop the current turn (esc)', args_hint: null },
  { name: 'usage', description: 'quota windows and resets', args_hint: null },
] as const

const REFUSALS: Record<RouteRefusal, { status: 409 | 429; code: string }> = {
  'too-soon': { status: 429, code: 'too_soon' },
  'provider-exhausted': { status: 409, code: 'provider_exhausted' },
  'ultracode-unsupported': { status: 409, code: 'ultracode_unsupported' },
  external: { status: 409, code: 'external_lifecycle' },
}

export function conductorControl(ports: ControlPorts) {
  const refuse = (status: 400 | 403 | 404 | 409 | 429 | 500 | 502 | 503, code: string, message: string): ControlResult => ({ refused: { status, code, message } })

  function secretsGate(): ControlResult | undefined {
    return ports.secretsOn() ? undefined : refuse(503, 'secrets_off', 'secrets are not configured on this server')
  }

  async function storeSecret(body: Record<string, unknown>): Promise<ControlResult> {
    const gate = secretsGate()
    if (gate) return gate
    const name = typeof body.name === 'string' ? body.name : ''
    const bad = nameError(name)
    if (bad) return refuse(400, 'bad_name', bad)
    const value = typeof body.value === 'string' ? body.value : ''
    if (!value || Buffer.byteLength(value) > SECRET_MAX_BYTES) return refuse(400, 'bad_value', 'value must be 1 byte to 64 KB of text')
    const topic = typeof body.topic === 'string' && body.topic ? body.topic : undefined
    if (topic !== undefined && !ports.listed(topic)) return refuse(404, 'not_found', 'no such topic')
    try {
      const stored = await ports.storeSecret(name, value, body.replace === true, topic)
      return { ok: { path: tilde(stored.path), bytes: stored.bytes, replaced: stored.replaced } }
    } catch (error) {
      if (error instanceof SecretExists) return refuse(409, 'secret_exists', `it exists (${error.bytes} bytes); send replace: true to overwrite it`)
      return refuse(500, 'store_failed', 'the secret could not be stored')
    }
  }

  async function deleteSecret(name: string): Promise<ControlResult> {
    const gate = secretsGate()
    if (gate) return gate
    const bad = nameError(name)
    if (bad) return refuse(400, 'bad_name', bad)
    try {
      return { ok: { name, bytes: (await ports.deleteSecret(name)).bytes } }
    } catch (error) {
      if (error instanceof SecretMissing) return refuse(404, 'not_found', 'no such secret')
      return refuse(500, 'delete_failed', 'the secret could not be deleted')
    }
  }

  function addReminder(topic: string, body: Record<string, unknown>): ControlResult {
    try {
      return { ok: wireReminder(ports.addReminder({ topic, at: body.at, text: body.text, prompt: body.prompt })) }
    } catch (error) {
      if (error instanceof InvalidReminder) return refuse(400, 'bad_reminder', error.message)
      throw error
    }
  }

  function cancelReminder(id: string): ControlResult {
    const cancelled = ports.cancelReminder(id)
    return cancelled ? { ok: wireReminder(cancelled) } : refuse(404, 'not_found', 'no such reminder')
  }
  const why = (error: unknown) => (error instanceof Error ? error.message : String(error))

  async function createTopic(body: Record<string, unknown>): Promise<ControlResult> {
    const name = topicName(body.name)
    if (typeof name !== 'string') return refuse(400, name.code, name.message)
    try {
      return { ok: { id: await ports.createTopic(name) } }
    } catch (error) {
      return refuse(502, 'chat_failed', `the chat did not create the topic: ${why(error)}`)
    }
  }

  async function patchTopic(topic: string, body: Record<string, unknown>): Promise<ControlResult> {
    const patch = topicPatch(body)
    if ('code' in patch) return refuse(400, patch.code, patch.message)
    if (patch.name !== undefined) {
      try {
        await ports.renameTopic(topic, patch.name)
      } catch (error) {
        return refuse(502, 'chat_failed', `the chat did not rename the topic: ${why(error)}`)
      }
    }
    const { name: _name, ...prefs } = patch
    if (Object.keys(prefs).length) ports.setPrefs(topic, prefs)
    return { ok: {} }
  }

  async function route(topic: string, body: unknown, origin: RouteOrigin = 'app'): Promise<ControlResult> {
    const why = ports.noAgent(topic) ?? ports.locked(topic)
    if (why) return refuse(409, 'no_route', why)
    const choice = routeChoice(ports.catalog(), body, ports.ultracode(topic))
    if ('code' in choice) return refuse(400, choice.code, choice.message)
    // Any local process can call the loopback API, so it never turns off a topic's permission checks.
    if (origin === 'loopback' && bypassesPermissions(choice.provider)) {
      return refuse(403, 'needs_operator', 'a route that skips permission checks is chosen from Telegram or the app')
    }
    await ports.echo(topic, `${ECHO[origin]}: /model ${choice.provider} ${choice.model.id} ${choice.effort}`)
    const request = ports.requestRoute(topic, choice)
    if ('refused' in request) {
      const { status, code } = REFUSALS[request.refused]
      return refuse(status, code, request.refused === 'too-soon' ? 'a route change just ran; wait a moment' : request.refused.replace('-', ' '))
    }
    await ports.say(topic, ports.routeChangeText(request))
    const { provider, model, effort } = request.route
    const state = request.outcome === 'queued' ? 'queued' : request.outcome === 'unchanged' ? 'unchanged' : 'applied'
    return { ok: { route: { provider, model, effort }, state } }
  }

  async function command(topic: string, body: unknown): Promise<ControlResult> {
    const name = (body as { name?: unknown } | null)?.name
    if (name === 'usage') {
      await ports.refreshCapacity()
      return { ok: { name, text: ports.usageText() } }
    }
    if (name !== 'relaunch' && name !== 'interrupt') return refuse(404, 'unknown_command', 'see GET /v1/commands')
    const noAgent = ports.noAgent(topic)
    if (noAgent) return refuse(409, 'no_agent', noAgent)
    if (name === 'relaunch') {
      await ports.echo(topic, 'You (app): /relaunch')
      await ports.relaunch(topic)
      return { ok: { name, text: 'Relaunching; the agent answers when it is back.' } }
    }
    const locked = ports.locked(topic)
    if (locked) return refuse(409, 'no_interrupt', locked)
    if (!ports.interrupt(topic)) return refuse(409, 'not_running', "this topic's agent is not running")
    await ports.echo(topic, 'You (app): interrupt')
    return { ok: { name, text: 'Pressed stop; the current turn ends.' } }
  }

  return {
    commands: () => ({ commands: COMMANDS }),
    /** Loopback callers learn which providers they may not pick (see `route`). */
    routes: (origin: RouteOrigin = 'app') => wireRoutes(ports.catalog(), origin === 'loopback' ? bypassesPermissions : undefined),
    async usage() {
      await ports.refreshCapacity()
      return wireUsage(ports.capacities())
    },
    route,
    command,
    createTopic,
    patchTopic,
    secrets: (): ControlResult => secretsGate() ?? { ok: wireSecrets(ports.listSecrets()) },
    storeSecret,
    deleteSecret,
    reminders: (topic: string) => ({ reminders: ports.topicReminders(topic).map(wireReminder) }),
    addReminder,
    cancelReminder,
  }
}

export type ConductorControl = ReturnType<typeof conductorControl>
