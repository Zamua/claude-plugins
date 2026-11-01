// A topic's agent state as the app shows it. Topics on hc report it live from
// their terminal; the others report only what the proxy's own lifecycle knows.
import { hcRuntime } from '../../shared/hc-terminals'
import type { HcTerminal } from '../../shared/hc-terminals'
import type { AgentState } from '../wire'

export type Lifecycle = 'stopped' | 'running' | 'failed'

/** `hc` is set for a topic on hc: whether its core answers, and the terminal hosting its session. */
export function agentState(lifecycle: Lifecycle, hc?: { core: boolean; terminal: HcTerminal | undefined }): AgentState {
  if (lifecycle === 'failed') return 'missing'
  if (lifecycle === 'stopped') return 'stopped'
  if (!hc) return 'idle'
  if (!hc.core) return 'missing'
  switch (hcRuntime(hc.terminal)) {
    case 'idle':
      return 'idle'
    case 'busy':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'starting':
      return 'starting'
    case 'missing':
      return 'missing'
  }
}
