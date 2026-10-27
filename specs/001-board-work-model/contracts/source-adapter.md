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
listSessions($, config): Promise<{ sessions: HostSession[]; error?: string }>
focusSession($, address: string): Promise<string | undefined>   // the reason when it could not
startSession($, config, start: HostStart): Promise<{ address?: string; error?: string }>

type HostSession = {
  address: string            // opaque to the core
  label: string
  state: 'working' | 'waiting' | 'idle' | 'done'
  harness?: string           // e.g. 'claude'
  harnessId?: string         // the Harness's own session id, when the Host knows it
}

type HostStart = {
  label: string
  cwd: string
  harness: string            // the Harness to run, e.g. 'claude'
  command: string[]          // from the Harness's launchCommand
  brief: string              // sent as the first prompt once the agent is up
}

// Harness: the agent inside a Session. One module per runtime, e.g. harnesses/claude.ts.
sessionInfo($, harnessId: string): Promise<{ activeMs: number; lastActive?: string; messageName?: string }>
launchCommand(config): string[]   // the command and arguments a Host runs to start this Harness
```

The `sources.herdr` config key becomes `hosts: { herdr: {} }`; `harnesses: { claude: {} }` names the
Harness. Pressing a session mark calls `focusSession` of the Session's own Host. The work tool's
`start` calls `startSession` of the first configured Host with the first configured Harness.
