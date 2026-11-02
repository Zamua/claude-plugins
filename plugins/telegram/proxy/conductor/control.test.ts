import { describe, expect, test } from 'bun:test'
import type { RouteChoice, RouteRequest } from '../routing/routing'
import { InvalidReminder } from '../reminders/domain/reminder'
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
    createTopic: async name => (name === 'boom' ? Promise.reject(new Error('Bad Request')) : '501'),
    renameTopic: async (topic, name) => void said.push(`renamed ${topic} to ${name}`),
    setPrefs: (topic, prefs) => void said.push(`prefs ${topic} ${JSON.stringify(prefs)}`),
    listed: topic => ['42', '7', 'agy', 'square'].includes(topic),
    secretsOn: () => true,
    listSecrets: () => [],
    storeSecret: async (name, value, replace) => ({ path: `/home/op/keys/${name}`, bytes: value.length, replaced: replace }),
    deleteSecret: async () => ({ bytes: 1 }),
    topicReminders: () => [],
    addReminder: () => { throw new Error('unused') },
    cancelReminder: () => undefined,
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

  test('a loopback change is echoed as the Crook backend and never picks a route that skips permission checks', async () => {
    const codex = [{ id: 'gpt-5.6-sol', label: 'Sol', efforts: ['medium' as const], defaultEffort: 'medium' as const }]
    const { control, said, requested } = setup({
      catalog: () => ({
        anthropic: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high', 'xhigh'], defaultEffort: 'xhigh', supportsUltracode: true }],
        codex,
        'opencode-go': [],
      }),
    })
    expect(await control.route('42', { provider: 'codex', model: 'gpt-5.6-sol' }, 'loopback')).toMatchObject({ refused: { status: 403, code: 'needs_operator' } })
    expect([requested, said]).toEqual([[], []])
    expect(await control.route('42', { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' }, 'loopback')).toMatchObject({ ok: { state: 'queued' } })
    expect(said[0]).toBe('Crook backend: /model anthropic claude-opus-5-5 high')
    expect(await control.route('42', { provider: 'codex', model: 'gpt-5.6-sol' })).toMatchObject({ ok: { state: 'queued' } })
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

describe('topics', () => {
  test('a topic is created by name and its id given; a chat failure is 502', async () => {
    const { control } = setup()
    expect(await control.createTopic({ name: ' build ' })).toEqual({ ok: { id: '501' } })
    expect(await control.createTopic({ name: '' })).toMatchObject({ refused: { status: 400, code: 'bad_name' } })
    expect(await control.createTopic({ name: 'boom' })).toMatchObject({ refused: { status: 502, code: 'chat_failed' } })
  })

  test('a patch renames through the chat and sets pin and mute apart from the name', async () => {
    const { control, said } = setup()
    expect(await control.patchTopic('42', { name: 'ci', muted: true })).toEqual({ ok: {} })
    expect(await control.patchTopic('42', { pinned: true })).toEqual({ ok: {} })
    expect(await control.patchTopic('42', { muted: 1 })).toMatchObject({ refused: { status: 400, code: 'bad_muted' } })
    expect(said).toEqual(['renamed 42 to ci', 'prefs 42 {"muted":true}', 'prefs 42 {"pinned":true}'])
  })
})

describe('secrets and reminders', () => {
  test('secrets are refused while off, by a bad name or value, or for an unlisted topic; a stored one answers with its tilde path', async () => {
    expect(await setup({ secretsOn: () => false }).control.storeSecret({ name: 'x', value: 'v' })).toMatchObject({ refused: { status: 503, code: 'secrets_off' } })
    const { control } = setup()
    expect(await control.storeSecret({ name: 'Bad Name', value: 'v' })).toMatchObject({ refused: { status: 400, code: 'bad_name' } })
    expect(await control.storeSecret({ name: 'ok', value: '' })).toMatchObject({ refused: { status: 400, code: 'bad_value' } })
    expect(await control.storeSecret({ name: 'ok', value: 'v', topic: 'nope' })).toMatchObject({ refused: { status: 404 } })
    const home = require('os').homedir()
    const stored = await setup({ storeSecret: async name => ({ path: `${home}/keys/${name}`, bytes: 1, replaced: false }) }).control.storeSecret({ name: 'ok', value: 'v' })
    expect(stored).toEqual({ ok: { path: '~/keys/ok', bytes: 1, replaced: false } })
  })

  test('a reminder the domain refuses is a 400 naming why; cancelling an unknown one is 404', () => {
    const { control } = setup({ addReminder: () => { throw new InvalidReminder('at must carry a zone') } })
    expect(control.addReminder('42', { at: 'x', text: 'y' })).toEqual({ refused: { status: 400, code: 'bad_reminder', message: 'at must carry a zone' } })
    expect(control.cancelReminder('rm_none')).toMatchObject({ refused: { status: 404 } })
  })
})

