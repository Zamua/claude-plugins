import { describe, expect, test } from 'bun:test'
import type { RouteChoice, RouteRequest } from '../routing/routing'
import { conductorControl } from './control'
import type { ControlPorts } from './control'

function setup(over: Partial<ControlPorts> = {}) {
  const said: string[] = []
  const requested: Array<{ topic: string; choice: RouteChoice }> = []
  const relaunched: string[] = []
  let refreshed = 0
  const ports: ControlPorts = {
    catalog: () => ({
      anthropic: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high', 'xhigh'], defaultEffort: 'xhigh', supportsUltracode: true }],
      codex: [],
      'opencode-go': [],
    }),
    capacities: () => [{ provider: 'anthropic', availability: 'available', observedAt: 0, windows: [{ name: '5h', usedPercent: 10, availability: 'available' }] }],
    refreshCapacity: async () => void refreshed++,
    usageText: () => 'Provider usage\n\nAnthropic: available',
    ultracode: () => false,
    requestRoute: (topic, choice): RouteRequest => {
      requested.push({ topic, choice })
      return { outcome: 'queued', route: { provider: choice.provider, model: choice.model.id, effort: choice.effort, ultracode: choice.ultracode } }
    },
    routeChangeText: r => `Queued ${r.route.model}.`,
    noAgent: topic => (topic === 'square' ? 'the square has no agent' : undefined),
    locked: topic => (topic === 'agy' ? 'locked to Antigravity' : undefined),
    relaunch: async topic => void relaunched.push(topic),
    interrupt: topic => topic === '42',
    say: async (_topic, text) => void said.push(text),
    ...over,
  }
  return { control: conductorControl(ports), said, requested, relaunched, refreshed: () => refreshed }
}

describe('route', () => {
  test('a valid choice is requested, echoed and reported into the topic, and answered with the route and its state', async () => {
    const { control, said, requested } = setup()
    const result = await control.route('42', { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' })
    expect(result).toEqual({ ok: { route: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' }, state: 'queued' } })
    expect(requested).toHaveLength(1)
    expect(said).toEqual(['You (app): /model anthropic claude-opus-5-5 high', 'Queued claude-opus-5-5.'])
  })

  test('a bad body, the square or a locked topic is refused before anything is requested or said', async () => {
    const { control, said, requested } = setup()
    expect(await control.route('42', { provider: 'anthropic', model: 'nope' })).toMatchObject({ refused: { status: 400, code: 'bad_model' } })
    expect(await control.route('square', { provider: 'anthropic', model: 'claude-opus-5-5' })).toMatchObject({ refused: { status: 409, code: 'no_route' } })
    expect(await control.route('agy', { provider: 'anthropic', model: 'claude-opus-5-5' })).toMatchObject({ refused: { status: 409, code: 'no_route' } })
    expect([requested, said]).toEqual([[], []])
  })

  test('routing\'s refusals keep their meaning: too soon is 429, a provider at its limit 409', async () => {
    for (const [refused, status, code] of [['too-soon', 429, 'too_soon'], ['provider-exhausted', 409, 'provider_exhausted']] as const) {
      const { control } = setup({ requestRoute: () => ({ refused }) })
      expect(await control.route('42', { provider: 'anthropic', model: 'claude-opus-5-5' })).toMatchObject({ refused: { status, code } })
    }
  })
})

describe('commands', () => {
  test('relaunch is echoed and handed to the lifecycle; the square has no agent to relaunch', async () => {
    const { control, said, relaunched } = setup()
    expect(await control.command('42', { name: 'relaunch' })).toMatchObject({ ok: { name: 'relaunch' } })
    expect(await control.command('agy', { name: 'relaunch' })).toMatchObject({ ok: { name: 'relaunch' } })
    expect(await control.command('square', { name: 'relaunch' })).toMatchObject({ refused: { status: 409, code: 'no_agent' } })
    expect(relaunched).toEqual(['42', 'agy'])
    expect(said).toEqual(['You (app): /relaunch', 'You (app): /relaunch'])
  })

  test('interrupt presses stop on a running agent, and says so only when it did', async () => {
    const { control, said } = setup()
    expect(await control.command('42', { name: 'interrupt' })).toMatchObject({ ok: { name: 'interrupt' } })
    expect(await control.command('7', { name: 'interrupt' })).toMatchObject({ refused: { status: 409, code: 'not_running' } })
    expect(await control.command('agy', { name: 'interrupt' })).toMatchObject({ refused: { status: 409, code: 'no_interrupt' } })
    expect(said).toEqual(['You (app): interrupt'])
  })

  test('usage refreshes and answers with the text Telegram shows; an unknown name is 404', async () => {
    const { control, said, refreshed } = setup()
    expect(await control.command('42', { name: 'usage' })).toEqual({ ok: { name: 'usage', text: 'Provider usage\n\nAnthropic: available' } })
    expect(refreshed()).toBe(1)
    expect(await control.command('42', { name: 'rm -rf' })).toMatchObject({ refused: { status: 404, code: 'unknown_command' } })
    expect(said).toEqual([])
  })
})

test('the reads: the palette, the catalog and the usage windows', async () => {
  const { control, refreshed } = setup()
  expect((control.commands().commands as readonly { name: string }[]).map(c => c.name)).toEqual(['relaunch', 'interrupt', 'usage'])
  expect(control.routes()).toMatchObject({ providers: [{ id: 'anthropic', models: [{ id: 'claude-opus-5-5', default_effort: 'xhigh' }] }, { id: 'codex' }, { id: 'opencode-go' }] })
  expect(await control.usage()).toEqual({ providers: [{ id: 'anthropic', windows: [{ name: '5h', used_percent: 10, resets_at: null }] }] })
  expect(refreshed()).toBe(1)
})
