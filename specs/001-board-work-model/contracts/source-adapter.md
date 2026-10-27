# Contract: Source adapter

Every Source is one module with one job: turn its system's data into core types. The core never
imports a Source; the work view lists the ones `boards.json` turns on.

```ts
type SourceSpec = {
  id: string                                    // 'file' | 'rhythms' | 'linear' | 'github' | 'herdr'
  freshMs: number                               // how old a cached answer may be
  read($: EngineInterface, config: unknown): Promise<SourceAnswer>
}

type SourceAnswer = {
  items?: Item[]
  sessions?: Session[]
  artifacts?: Artifact[]
  error?: string                                // shown on the freshness line; last answer stays
}
```

Rules:

- `read` fetches everything it serves in as few calls as it can, and never throws: a failure
  returns `error`.
- External Sources (Rhythms, Linear) go through the shared cache at `~/.cache/board/<source>.json`,
  with the same pause and budget rules as the GitHub cache: asked only by sessions in use, never
  while a pause is set.
- Local Sources (file, herdr) read on every refresh.
- An adapter maps its own levels to Kinds through its `kinds` config, and its own states to Status
  (research R8), and puts its identifiers in `aliases`.
- Adding a Source means adding one module and one `sources` key; nothing else changes.
