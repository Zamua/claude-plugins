// The operator's commands from the app: a route switch, relaunch, interrupt,
// usage, and creating, renaming, pinning and muting topics. Each runs through the same routing and lifecycle Telegram's
// verbs use, and an act that changes a topic is echoed into it, so Telegram
// stays the full record.
import type { ProviderCapacity } from '../routing/domain/provider-capacity'
import type { ProviderCatalog } from '../routing/provider-catalog'
import type { RouteChoice, RouteRefusal, RouteRequest } from '../routing/routing'
import { routeChoice } from './domain/route-choice'
import { topicName, topicPatch } from './domain/topic-edit'
import { wireRoutes, wireUsage } from './wire'

export type ControlResult =
  | { ok: Record<string, unknown> }
  | { refused: { status: 400 | 404 | 409 | 429 | 502; code: string; message: string } }

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
  /** Creates a Claude topic in the chat and the proxy; gives its id. */
  createTopic: (name: string) => Promise<string>
  /** Renames the chat's topic and the proxy's record of it. */
  renameTopic: (topic: string, name: string) => Promise<void>
  /** The app's own pin and mute. */
  setPrefs: (topic: string, prefs: { pinned?: boolean; muted?: boolean }) => void
}

export const COMMANDS = [
  { name: 'relaunch', description: "restart this topic's agent, same conversation", args_hint: null },
  { name: 'interrupt', description: 'stop the current turn (esc)', args_hint: null },
  { name: 'usage', description: 'quota windows and resets', args_hint: null },
] as const

const REFUSALS: Record<RouteRefusal, { status: 409 | 429; code: string }> = {
  'too-soon': { status: 429, code: 'too_soon' },
  'provider-exhausted': { status: 409, code: 'provider_exhausted' },
  'ultracode-unsupported': { status: 409, code: 'ultracode_unsupported' },
}

export function conductorControl(ports: ControlPorts) {
  const refuse = (status: 400 | 404 | 409 | 429 | 502, code: string, message: string): ControlResult => ({ refused: { status, code, message } })
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

  async function route(topic: string, body: unknown): Promise<ControlResult> {
    const why = ports.noAgent(topic) ?? ports.locked(topic)
    if (why) return refuse(409, 'no_route', why)
    const choice = routeChoice(ports.catalog(), body, ports.ultracode(topic))
    if ('code' in choice) return refuse(400, choice.code, choice.message)
    await ports.say(topic, `You (app): /model ${choice.provider} ${choice.model.id} ${choice.effort}`)
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
      await ports.say(topic, 'You (app): /relaunch')
      await ports.relaunch(topic)
      return { ok: { name, text: 'Relaunching; the agent answers when it is back.' } }
    }
    const locked = ports.locked(topic)
    if (locked) return refuse(409, 'no_interrupt', locked)
    if (!ports.interrupt(topic)) return refuse(409, 'not_running', "this topic's agent is not running")
    await ports.say(topic, 'You (app): interrupt')
    return { ok: { name, text: 'Pressed stop; the current turn ends.' } }
  }

  return {
    commands: () => ({ commands: COMMANDS }),
    routes: () => wireRoutes(ports.catalog()),
    async usage() {
      await ports.refreshCapacity()
      return wireUsage(ports.capacities())
    },
    route,
    command,
    createTopic,
    patchTopic,
  }
}

export type ConductorControl = ReturnType<typeof conductorControl>
