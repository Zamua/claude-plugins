# Contract: Source adapter

Every Source is one module with one job: turn its system's data into core types. The core never
imports a Source; the work view lists the ones `boards.json` turns on.

```ts
// One module per Source, e.g. sources/linear.ts, exporting:
const FRESH_MS: number                                       // how old a cached answer may be
async function readLinear($: EngineInterface, config: unknown): Promise<SourceAnswer>

type SourceAnswer = {
  items?: Item[]
  sessions?: Session[]
  artifacts?: Artifact[]
  error?: string                                // shown on the freshness line; last answer stays
}
```

Rules:

- The read function fetches everything it serves in as few calls as it can, and never throws: a failure
  returns `error`.
- External Sources (Rhythms, Linear) go through the shared cache at `~/.cache/board/<source>.json`,
  with the same pause and budget rules as the GitHub cache: asked only by sessions in use, never
  while a pause is set.
- Local Sources (file) and Hosts read on every refresh.
- An adapter maps its own levels to Kinds through its `kinds` config, and its own states to Status
  (research R8), and puts its identifiers in `aliases`.
- Adding a Source means adding one module and one `sources` key; nothing else changes.
- The mod validator lets `$` reach only function declarations, so an adapter is a set of exported
  functions named in one dispatch function per port, not an object with methods.

## Host and Harness ports

Sessions come from two more ports, so the core never names a multiplexer or an agent runtime.

```ts
// Host: where Sessions run. One module per multiplexer, e.g. hosts/herdr.ts.
listHerdr($): Promise<{ sessions: HostSession[]; error?: string }>
focusHerdr($, address: string): Promise<string | undefined>   // the reason when it could not
startHerdr($, start: HostStart): Promise<{ address?: string; error?: string }>

type HostSession = {
  address: string            // opaque to the core
  label: string
  state: 'waiting' | 'done' | 'working' | 'idle'
  harness?: string           // e.g. 'claude'
  harnessId?: string         // the Harness's own session id, when the Host knows it
}

type HostStart = {
  label: string
  cwd: string
  harness: string            // the Harness to run, e.g. 'claude'
  args: string[]             // from the Harness's config
  brief: string              // sent as the first prompt once the agent is up
  near?: string              // the starting Session's address, so the new one starts beside it
}

// Harness: the agent inside a Session. One module per runtime, e.g. harnesses/claude.ts.
claudeInfo($, harnessIds: string[]): Promise<Map<string, { messageName?: string; lastActive?: number }>>
claudeArgs(config): string[]
```

`hooks/work/sessions.ts` dispatches by the Host and Harness names in config, and adds each Session's
goal and summary from its session board.

The `sources.herdr` config key becomes `hosts: { herdr: {} }`; `harnesses: { claude: {} }` names the
Harness. Pressing a session mark calls `focusSession` of the Session's own Host. The work tool's
`start` calls `startSession` of the first configured Host with the first configured Harness.
