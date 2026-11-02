// OpenCode's model metadata (context windows, effort variants) for the catalog.
// Read through a private server of the installed binary (`--standalone`): the
// shared background service keeps the build it started with across upgrades.
// Refreshed in the background, so the synchronous catalog reads the last good
// answer and never waits on a server start.
import type { ProcessRunner } from '../shared/process-runner'
import { parseOpenCodeModels } from './provider-catalog'
import type { ProviderModel } from './provider-catalog'

export function openCodeModelMetadata(ports: { run: ProcessRunner; bin: string; cwd: string; log: (line: string) => void }) {
  let models = new Map<string, ProviderModel>()
  let refreshing = false

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const { stdout } = await ports.run(ports.bin, ['api', '--standalone', 'model.list'], { cwd: ports.cwd, timeout: 30_000 })
      const read = parseOpenCodeModels(stdout)
      if (read.size) models = read
      else ports.log('OpenCode model metadata: the answer named no models; keeping the last')
    } catch (error) {
      ports.log(`OpenCode model metadata failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      refreshing = false
    }
  }

  /** The last good metadata; a new map after each successful refresh, so a cache can key on it. */
  return { refresh, current: (): Map<string, ProviderModel> => models }
}
