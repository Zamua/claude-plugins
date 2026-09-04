import { describe, expect, test } from 'bun:test'
import {
  findOpencodePane,
  HerdrOpencodeRuntime,
  opencodeHerdrStatus,
  opencodeInteractiveArgs,
  opencodeMcpConfigContent,
  OPENCODE_SETTLE_MS,
  parseHerdrPromptResult,
  parseOpencodeExport,
  parseOpencodeSessionArgument,
  parseOpencodeSessionList,
} from './herdr-opencode-runtime'
import type { ProcessRunner } from './process-runner'

const idlePaneList = JSON.stringify({ result: { panes: [{
  label: 'oc-topic-42', pane_id: 'w2:p1', agent_status: 'idle',
}] } })

const processInfo = (argv: string[]) => JSON.stringify({ result: { process_info: {
  foreground_processes: [{ name: 'opencode', pid: 123, argv }],
} } })

const runtime = (run: ProcessRunner, pause: (ms: number) => Promise<unknown> = async () => {}) =>
  new HerdrOpencodeRuntime(
    'opencode', '/tmp/project', '/tmp/launcher', 'http://127.0.0.1:8790',
    '/tmp/bun', '/tmp/plugin/server.ts', 'herdr', run, pause, 'qwen-local/Qwen3.8-27B',
  )

const paneList = (status: string) => JSON.stringify({ result: { panes: [{
  label: 'oc-topic-42', pane_id: 'w2:p1', agent_status: status,
}] } })

// Fake clock: each pause advances time by its argument, nothing else does.
const settleHarness = (statuses: string[]) => {
  let clock = 0
  let observations = 0
  const promptCalls: number[] = []
  const now = Date.now
  Date.now = () => clock
  const run: ProcessRunner = async (_command, args) => {
    if (args[0] === 'pane' && args[1] === 'list') {
      const status = statuses[Math.min(observations, statuses.length - 1)]!
      observations++
      return { stdout: paneList(status), stderr: '' }
    }
    if (args[0] === 'agent' && args[1] === 'prompt') {
      promptCalls.push(observations)
      return { stdout: JSON.stringify({ result: { type: 'agent_prompted' } }), stderr: '' }
    }
    throw new Error(`unexpected args: ${args.join(' ')}`)
  }
  const pause = async (ms: number) => { clock += ms }
  return {
    runtime: runtime(run, pause),
    promptCalls,
    observations: () => observations,
    restore: () => { Date.now = now },
  }
}

describe('persistent Herdr OpenCode adapter', () => {
  test('starts a fresh session with the kickoff as the first prompt', () => {
    expect(opencodeInteractiveArgs({
      projectDir: '/tmp/project',
      model: 'qwen-local/Qwen3.8-27B',
      kickoff: 'setup; do not shell-parse this',
    })).toEqual([
      '/tmp/project', '-m', 'qwen-local/Qwen3.8-27B', '--pure', '--prompt', 'setup; do not shell-parse this',
    ])
  })

  test('resumes the exact session without replaying the kickoff', () => {
    expect(opencodeInteractiveArgs({
      projectDir: '/tmp/project',
      model: 'qwen-local/Qwen3.8-27B',
      opencodeSessionId: 'ses_1',
      kickoff: 'must not be sent again',
    })).toEqual(['/tmp/project', '-m', 'qwen-local/Qwen3.8-27B', '--pure', '-s', 'ses_1'])
  })

  test('builds the outbound-only Telegram MCP config layer', () => {
    expect(JSON.parse(opencodeMcpConfigContent('/tmp/bun', '/tmp/plugin/server.ts'))).toEqual({
      mcp: { 'telegram-topics': {
        type: 'local', command: ['/tmp/bun', '/tmp/plugin/server.ts'], enabled: true,
      } },
    })
  })

  test('finds a pane by its stable label and maps Herdr lifecycle state', () => {
    const output = JSON.stringify({ result: { panes: [
      { label: 'other', pane_id: 'w1:p1', agent_status: 'idle' },
      { label: 'oc-pilot-42', pane_id: 'w2:p1', agent_status: 'working' },
    ] } })
    const pane = findOpencodePane(output, 'oc-pilot-42')
    expect(pane).toEqual({ paneId: 'w2:p1', status: 'working' })
    expect(opencodeHerdrStatus(pane, true)).toBe('busy')
    expect(opencodeHerdrStatus({ paneId: 'w2:p1', status: 'unknown' }, true)).toBe('starting')
    expect(opencodeHerdrStatus({ paneId: 'w2:p1', status: 'unknown' }, false)).toBe('missing')
    expect(opencodeHerdrStatus(undefined, true)).toBe('missing')
  })

  test('lists only sessions created inside the launch window', () => {
    const fresh = { id: 'ses_new', created: 10_000, updated: 10_500, directory: '/tmp/project' }
    const older = { id: 'ses_old', created: 1_000, updated: 10_600, directory: '/tmp/project' }
    const sibling = { id: 'ses_manual', created: 10_200, updated: 10_300, directory: '/tmp/project' }
    expect(parseOpencodeSessionList(JSON.stringify([fresh]), 9_000, 11_000)).toEqual(['ses_new'])
    expect(parseOpencodeSessionList(JSON.stringify([fresh, older]), 9_000, 11_000)).toEqual(['ses_new'])
    expect(parseOpencodeSessionList(JSON.stringify([older]), 9_000, 11_000)).toEqual([])
    expect(parseOpencodeSessionList(JSON.stringify([fresh, sibling]), 9_000, 11_000))
      .toEqual(['ses_new', 'ses_manual'])
    expect(parseOpencodeSessionList('[]', 0, 1)).toEqual([])
    expect(parseOpencodeSessionList('not json', 0, 1)).toEqual([])
  })

  test('reads an explicit resume identity from the opencode process arguments', () => {
    expect(parseOpencodeSessionArgument(processInfo(['opencode', '/tmp/project', '-s', 'ses_1'])))
      .toBe('ses_1')
    expect(parseOpencodeSessionArgument(processInfo(['opencode', '--session', 'ses_2'])))
      .toBe('ses_2')
    expect(parseOpencodeSessionArgument(processInfo(['opencode', '--session=ses_3'])))
      .toBe('ses_3')
    expect(parseOpencodeSessionArgument(processInfo(['opencode', '--prompt', 'kickoff'])))
      .toBeUndefined()
  })

  test('distinguishes an accepted prompt from Herdr\'s zero-exit stalled result', () => {
    expect(parseHerdrPromptResult(JSON.stringify({ result: { type: 'agent_prompted' } })))
      .toBe('agent_prompted')
    expect(parseHerdrPromptResult('not json')).toBeUndefined()
  })

  test('launches a fresh pane and discovers the session created by that launch', async () => {
    let launchEnv: NodeJS.ProcessEnv | undefined
    let listCalls = 0
    const panes: string[] = []
    const run: ProcessRunner = async (command, args, options) => {
      if (command === '/tmp/launcher') {
        launchEnv = options.env
        panes.push(idlePaneList)
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return { stdout: panes[0] ?? JSON.stringify({ result: { panes: [] } }), stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return { stdout: processInfo(['opencode', '/tmp/project', '--prompt', 'kickoff']), stderr: '' }
      }
      if (command === 'opencode' && args[0] === 'session') {
        listCalls++
        expect(args).toEqual(['session', 'list', '--format', 'json', '-n', '20'])
        expect(options.cwd).toBe('/tmp/project')
        return {
          stdout: JSON.stringify([{ id: 'ses_fresh', created: Date.now(), updated: Date.now() }]),
          stderr: '',
        }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }

    expect(await runtime(run).ensureSession({
      topic: '42', name: 'topic', sessionName: 'oc-topic-42', kickoff: 'kickoff',
    })).toEqual({ sessionName: 'oc-topic-42', opencodeSessionId: 'ses_fresh' })
    expect(listCalls).toBe(1)
    expect(launchEnv?.OC_SESSION).toBe('oc-topic-42')
    expect(launchEnv?.OC_SPAWN_DIR).toBe('/tmp/project')
    expect(launchEnv?.OC_BIN).toBe('opencode')
    expect(JSON.parse(launchEnv?.OC_ARGS_JSON ?? '[]')).toEqual([
      '/tmp/project', '-m', 'qwen-local/Qwen3.8-27B', '--pure', '--prompt', 'kickoff',
    ])
    expect(JSON.parse(launchEnv?.OC_CONFIG_CONTENT ?? '{}').mcp['telegram-topics'].command)
      .toEqual(['/tmp/bun', '/tmp/plugin/server.ts'])
    expect(launchEnv?.TELEGRAM_TOPIC_ID).toBe('42')
    expect(launchEnv?.TELEGRAM_PROXY_URL).toBe('http://127.0.0.1:8790')
  })

  test('relaunches an exact session and confirms it from argv, not creation time', async () => {
    const panes: string[] = []
    let listCalls = 0
    const run: ProcessRunner = async (command, args) => {
      if (command === '/tmp/launcher') {
        panes.push(idlePaneList)
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return { stdout: panes[0] ?? JSON.stringify({ result: { panes: [] } }), stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return { stdout: processInfo(['opencode', '/tmp/project', '-s', 'ses_old']), stderr: '' }
      }
      if (command === 'opencode' && args[0] === 'session') {
        listCalls++
        return { stdout: JSON.stringify([{ id: 'ses_old', created: 1, updated: Date.now() }]), stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }

    let clock = 0
    const now = Date.now
    Date.now = () => clock
    try {
      expect(await runtime(run, async ms => { clock += ms }).ensureSession({
        topic: '42', name: 'topic', sessionName: 'oc-topic-42', opencodeSessionId: 'ses_old', kickoff: 'kickoff',
      })).toEqual({ sessionName: 'oc-topic-42', opencodeSessionId: 'ses_old' })
    } finally {
      Date.now = now
    }
    expect(listCalls).toBe(0)
  })

  test('rejects a stale pre-existing session after a fresh launch', async () => {
    let paneLists = 0
    const run: ProcessRunner = async (command, args) => {
      if (command === '/tmp/launcher') return { stdout: '', stderr: '' }
      if (args[0] === 'pane' && args[1] === 'list') {
        // Absent before the launch, idle afterwards.
        return { stdout: paneLists++ ? idlePaneList : JSON.stringify({ result: { panes: [] } }), stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return { stdout: processInfo(['opencode', '--prompt', 'kickoff']), stderr: '' }
      }
      if (command === 'opencode') {
        return { stdout: JSON.stringify([{ id: 'ses_old', created: 1_000 }]), stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }
    // A jumping clock expires the 180 s discovery window after one poll.
    const now = Date.now
    let calls = 0
    Date.now = () => now() + (calls++ > 3 ? 400_000 : 0)
    try {
      await expect(runtime(run).ensureSession({
        topic: '42', name: 'topic', sessionName: 'oc-topic-42', kickoff: 'kickoff',
      })).rejects.toThrow('did not become ready')
    } finally {
      Date.now = now
    }
  })

  test('closes a live pane with no persisted id and relaunches to capture identity', async () => {
    const closed: string[] = []
    let launched = 0
    let listCalls = 0
    const run: ProcessRunner = async (command, args) => {
      if (command === '/tmp/launcher') {
        launched++
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        // Live before the close, gone until the launch, idle after it.
        const live = closed.length === 0 || launched > 0
        return { stdout: live ? idlePaneList : JSON.stringify({ result: { panes: [] } }), stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return { stdout: processInfo(['opencode', '/tmp/project', '--prompt', 'kickoff']), stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        closed.push(args[2]!)
        return { stdout: '', stderr: '' }
      }
      if (command === 'opencode' && args[0] === 'session') {
        listCalls++
        expect(launched).toBe(1)
        return {
          stdout: JSON.stringify([
            { id: 'ses_manual', created: Date.now() - 3_600_000 },
            { id: 'ses_fresh', created: Date.now() },
          ]),
          stderr: '',
        }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }

    expect(await runtime(run).ensureSession({
      topic: '42', name: 'topic', sessionName: 'oc-topic-42', kickoff: 'kickoff',
    })).toEqual({ sessionName: 'oc-topic-42', opencodeSessionId: 'ses_fresh' })
    expect(closed).toEqual(['w2:p1'])
    expect(launched).toBe(1)
    expect(listCalls).toBe(1)
  })

  test('refuses an ambiguous launch when two sessions were created since it', async () => {
    const closed: string[] = []
    let launched = 0
    const run: ProcessRunner = async (command, args) => {
      if (command === '/tmp/launcher') {
        launched++
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return { stdout: launched ? idlePaneList : JSON.stringify({ result: { panes: [] } }), stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        closed.push(args[2]!)
        return { stdout: '', stderr: '' }
      }
      if (command === 'opencode' && args[0] === 'session') {
        return {
          stdout: JSON.stringify([
            { id: 'ses_a', created: Date.now() },
            { id: 'ses_b', created: Date.now() },
          ]),
          stderr: '',
        }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }

    await expect(runtime(run).ensureSession({
      topic: '42', name: 'topic', sessionName: 'oc-topic-42', kickoff: 'kickoff',
    })).rejects.toThrow('ambiguous')
    expect(closed).toEqual(['w2:p1'])
  })

  test('trusts the persisted identity for a live pane without listing sessions', async () => {
    let listCalls = 0
    const run: ProcessRunner = async (command, args) => {
      if (command === 'opencode') {
        listCalls++
        return { stdout: '[]', stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'list') return { stdout: idlePaneList, stderr: '' }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return { stdout: processInfo(['opencode', '/tmp/project', '-s', 'ses_1']), stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }

    expect(await runtime(run).ensureSession({
      topic: '42', name: 'topic', sessionName: 'oc-topic-42',
      opencodeSessionId: 'ses_1', kickoff: 'unused',
    })).toEqual({ sessionName: 'oc-topic-42', opencodeSessionId: 'ses_1' })
    expect(listCalls).toBe(0)
  })

  test('closes a same-labelled pane when it resumed the wrong session', async () => {
    const closed: string[] = []
    const run: ProcessRunner = async (command, args) => {
      if (args[0] === 'pane' && args[1] === 'list') return { stdout: idlePaneList, stderr: '' }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return { stdout: processInfo(['opencode', '/tmp/project', '-s', 'ses_other']), stderr: '' }
      }
      if (args[0] === 'pane' && args[1] === 'close') {
        closed.push(args[2]!)
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }

    await expect(runtime(run).ensureSession({
      topic: '42', name: 'topic', sessionName: 'oc-topic-42',
      opencodeSessionId: 'ses_1', kickoff: 'unused',
    })).rejects.toThrow('resumed ses_other')
    expect(closed).toEqual(['w2:p1'])
  })

  test('retries a structured prompt stall instead of silently dropping the turn', async () => {
    let promptCalls = 0
    let clock = 0
    const now = Date.now
    Date.now = () => clock
    const run: ProcessRunner = async (_command, args) => {
      if (args[0] === 'pane' && args[1] === 'list') return { stdout: idlePaneList, stderr: '' }
      if (args[0] === 'agent' && args[1] === 'prompt') {
        promptCalls++
        expect(args.slice(2)).toEqual([
          'w2:p1', 'telegram turn', '--wait', '--timeout', String(31 * 60_000),
        ])
        return {
          stdout: JSON.stringify({ result: {
            type: promptCalls === 1 ? 'agent_prompt_stalled' : 'agent_prompted',
          } }),
          stderr: '',
        }
      }
      throw new Error(`unexpected args: ${args.join(' ')}`)
    }

    try {
      await runtime(run, async ms => { clock += ms }).prompt('oc-topic-42', 'telegram turn')
    } finally {
      Date.now = now
    }
    expect(promptCalls).toBe(2)
  })

  test('a steady idle pane settles once the stability window elapses', async () => {
    const h = settleHarness(['idle'])
    try {
      await h.runtime.prompt('oc-topic-42', 'telegram turn')
      // Window before delivery plus window after agent_prompted, one poll per second.
      const perWindow = OPENCODE_SETTLE_MS / 1000
      expect(h.promptCalls).toEqual([perWindow + 1])
      expect(h.observations()).toBe(2 * (perWindow + 1))
    } finally {
      h.restore()
    }
  })

  test('an idle-working-idle flicker after the prompt delays settle', async () => {
    const perWindow = OPENCODE_SETTLE_MS / 1000
    // Delivery window observed idle throughout; after the prompt the pane
    // reports idle twice, works once, then stays idle.
    const before = Array(perWindow + 1).fill('idle')
    const h = settleHarness([...before, 'idle', 'idle', 'working', 'idle'])
    try {
      await h.runtime.prompt('oc-topic-42', 'telegram turn')
      expect(h.promptCalls).toEqual([perWindow + 1])
      // Two idle polls were discarded by the working observation.
      expect(h.observations()).toBe(before.length + 3 + perWindow + 1)
    } finally {
      h.restore()
    }
  })

  test('a blocked pane still throws instead of settling', async () => {
    const h = settleHarness(['idle', 'idle', 'blocked'])
    try {
      await expect(h.runtime.prompt('oc-topic-42', 'telegram turn')).rejects.toThrow('is blocked')
      expect(h.promptCalls).toEqual([])
    } finally {
      h.restore()
    }
  })

  test('parses the last assistant message out of an opencode export', () => {
    const exported = (messages: unknown[]) => JSON.stringify({ info: {}, messages })
    expect(parseOpencodeExport(exported([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'old' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'again' }] },
      { info: { role: 'assistant', finish: 'stop' }, parts: [
        { type: 'step-start' },
        { type: 'text', text: ' first ' },
        { type: 'tool', text: 'ignored' },
        { type: 'text', text: 'second' },
      ] },
    ]))).toEqual({ text: 'first \nsecond', finish: 'stop' })
    expect(parseOpencodeExport(exported([
      { info: { role: 'assistant', finish: 'length' }, parts: [
        { type: 'reasoning', text: 'thinking...' },
      ] },
    ]))).toEqual({ text: '', finish: 'length' })
    expect(parseOpencodeExport(exported([{ info: { role: 'user' }, parts: [] }]))).toBeUndefined()
    expect(parseOpencodeExport('not json')).toBeUndefined()
    expect(parseOpencodeExport('{}')).toBeUndefined()
  })

  test('lastAssistantText exports the session from the project dir', async () => {
    const run: ProcessRunner = async (command, args, options) => {
      expect(command).toBe('opencode')
      expect(args).toEqual(['export', 'ses_1'])
      expect(options.cwd).toBe('/tmp/project')
      return { stdout: JSON.stringify({ messages: [
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'done' }] },
      ] }), stderr: '' }
    }
    expect(await runtime(run).lastAssistantText('ses_1')).toEqual({ text: 'done', finish: 'stop' })
    const failing: ProcessRunner = async () => { throw new Error('boom') }
    expect(await runtime(failing).lastAssistantText('ses_1')).toBeUndefined()
  })
})
