// Relaunch on the root's word: the root's agent (general's Claude) relaunches
// topics under it, each now or at the end of its current turn, as /relaunch
// does. Every decision, refusals included, is a ledger entry before anything
// runs.
import { callerIsRoot, relaunchTarget } from './domain/relaunch'
import type { TargetFacts, TargetResult } from './domain/relaunch'

export type LedgerRecord = { kind: string } & Record<string, unknown>

export type RelaunchBrokerPorts = {
  root: string
  /** The root's agent pid as its multiplexer reports it now; undefined while it is not running. */
  rootAgentPid: () => number | undefined
  facts: (topic: string) => TargetFacts | undefined
  relaunch: (topic: string) => Promise<void>
  /** The topic whose agent is among these pids, to name the caller of a refusal. */
  callerTopic: (ancestry: readonly number[]) => string | undefined
  record: (entry: LedgerRecord) => void
  log: (line: string) => void
  /** The least time between two relaunches, so the restarted sessions' first replies do not all hit the chat at once. */
  staggerMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export const RELAUNCH_STAGGER_MS = 3_000

export type RelaunchAnswer = { caller: string | null; results: TargetResult[] }

export function createRelaunchBroker(ports: RelaunchBrokerPorts) {
  const { root, record, log } = ports
  const { staggerMs = RELAUNCH_STAGGER_MS, sleep = Bun.sleep, now = Date.now } = ports
  const queued = new Set<string>()

  // One relaunch at a time, at least staggerMs after the last, whichever request or sweep asked.
  let lastStart = -Infinity
  let tail: Promise<void> = Promise.resolve()
  function paced(topic: string): Promise<void> {
    const run = tail.then(async () => {
      const wait = lastStart + staggerMs - now()
      if (wait > 0) await sleep(wait)
      lastStart = now()
      await ports.relaunch(topic)
    })
    tail = run.catch(() => {})
    return run
  }

  async function request(callerPid: number | undefined, ancestry: readonly number[], topics: readonly string[]): Promise<RelaunchAnswer> {
    const targets = [...new Set(topics)]
    if (callerPid === undefined || !callerIsRoot(ancestry, ports.rootAgentPid())) {
      const caller = callerPid === undefined ? undefined : ports.callerTopic(ancestry)
      const reason = `only ${root}'s agent may relaunch topics`
      record({ kind: 'relaunch_refused', caller_pid: callerPid ?? null, caller_topic: caller ?? null, targets, reason })
      log(`broker: refused a relaunch of ${targets.join(', ')} from pid ${callerPid ?? '?'} (${caller ?? 'no topic'})`)
      return { caller: caller ?? null, results: targets.map(topic => ({ topic, outcome: 'refused', reason })) }
    }
    const results: TargetResult[] = []
    for (const topic of targets) {
      const result = relaunchTarget(topic, root, ports.facts)
      record({ kind: 'relaunch', caller: root, caller_pid: callerPid, target: topic, outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) })
      log(`broker: ${root} relaunch of ${topic}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`)
      if (result.outcome === 'applied') await paced(topic)
      if (result.outcome === 'queued') queued.add(topic)
      else queued.delete(topic)
      results.push(result)
    }
    return { caller: root, results }
  }

  /** Relaunches each queued topic whose turn has ended; one whose agent stopped meanwhile has nothing left to do. */
  async function sweep(): Promise<void> {
    for (const topic of [...queued]) {
      const facts = ports.facts(topic)
      if (!facts?.running) {
        queued.delete(topic)
        log(`broker: queued relaunch of ${topic} dropped, its agent stopped`)
        continue
      }
      if (!facts.idle) continue
      queued.delete(topic)
      record({ kind: 'relaunch', caller: root, target: topic, outcome: 'applied', queued: true })
      log(`broker: queued relaunch of ${topic} applied at its turn's end`)
      await paced(topic)
    }
  }

  return { request, sweep, queued: (): ReadonlySet<string> => queued }
}

export type RelaunchBroker = ReturnType<typeof createRelaunchBroker>
