// Parsing for `herdr pane list` output, shared by every Herdr-hosted harness.

export type HerdrPane = { paneId: string; status: string }

/** Panes keyed by label; malformed output reads as no panes. */
export function parseHerdrPanes(output: string): Map<string, HerdrPane> {
  const panes = new Map<string, HerdrPane>()
  try {
    for (const pane of JSON.parse(output)?.result?.panes ?? []) {
      if (!pane?.label) continue
      panes.set(String(pane.label), {
        paneId: String(pane.pane_id ?? ''),
        status: String(pane.agent_status ?? 'unknown'),
      })
    }
  } catch {}
  return panes
}

export function findHerdrPane(output: string, label: string): HerdrPane | undefined {
  const pane = parseHerdrPanes(output).get(label)
  return pane?.paneId ? pane : undefined
}

export type AgentRuntime = 'missing' | 'starting' | 'idle' | 'busy' | 'blocked'

// Herdr reports "unknown" both for a pane whose agent has exited and for the
// first seconds of a fresh one, so the foreground process decides between them.
// A "working" Claude pane whose foreground prompt is blank is idle: only
// background work is running.
export function herdrAgentStatus(
  status: string,
  foregroundIsAgent: boolean,
  foregroundPromptVisible = false,
): AgentRuntime {
  if (status === 'idle' || status === 'done') return 'idle'
  if (status === 'working') return foregroundPromptVisible ? 'idle' : 'busy'
  if (status === 'blocked') return 'blocked'
  return foregroundIsAgent ? 'starting' : 'missing'
}
