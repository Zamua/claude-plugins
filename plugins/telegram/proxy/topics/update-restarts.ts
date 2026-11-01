// Claude Code updates itself, but a running session keeps the binary it started
// with. Each sweep moves a topic whose live Claude is older than the installed
// one over at a turn boundary (domain/claude-update.ts): an idle one is stopped
// and resumes on its next message; one mid-turn, running background tasks, or
// waiting on the operator is left alone until it goes idle, then restarted and
// resumed at once with a one-line notice. Process records come from Claude Code
// itself, so this needs no multiplexer query.
import { GROUP_CHAT_ID, SQUARE_TOPIC } from '../config'
import { log } from '../log'
import { installedClaudeVersion, liveClaudeSessions } from './claude-sessions'
import type { LiveClaudeSession } from './claude-sessions'
import { updateRestartAction } from './domain/claude-update'
import { pendingPerms } from './permissions'
import { saveRegistry } from './registry'
import { topics } from './state'
import type { TopicState } from './state'
import type { SpawnOutcome } from './lifecycle'

export type UpdateRestartPorts = {
  sayIn: (chatId: string, topic: string, text: string) => Promise<unknown>
  harnessLocked: (topic: string) => boolean
  killSession: (st: TopicState, topic: string) => boolean
  ensureSession: (topic: string) => SpawnOutcome
  paneInFlight: (topic: string) => boolean
  installedVersion?: () => string | undefined
  liveSessions?: () => Map<string, LiveClaudeSession>
}

export function createUpdateRestarts({
  sayIn,
  harnessLocked,
  killSession,
  ensureSession,
  paneInFlight,
  installedVersion = installedClaudeVersion,
  liveSessions = liveClaudeSessions,
}: UpdateRestartPorts) {
  const deferred = new Set<string>()
  const attempted = new Map<string, string>()

  function proxyHoldsWork(topic: string, st: TopicState): boolean {
    if (st.queue.length > 0 || paneInFlight(topic)) return true
    for (const pending of pendingPerms.values()) if (pending.topic === topic) return true
    return false
  }

  function sweep(): void {
    const installed = installedVersion()
    if (!installed) return
    const sessions = liveSessions()
    for (const [topic, st] of topics) {
      if (SQUARE_TOPIC && topic === SQUARE_TOPIC) continue
      if (harnessLocked(topic) || st.spawning || !st.session || !st.claudeSessionId) continue
      const claude = sessions.get(st.claudeSessionId)
      const action = updateRestartAction({
        running: claude?.version,
        installed,
        activity: claude?.activity,
        activitySince: claude?.activitySince,
        now: Date.now(),
        proxyBusy: proxyHoldsWork(topic, st),
        deferred: deferred.has(topic),
        attempted: attempted.get(topic) === installed,
      })
      if (action === 'none') {
        deferred.delete(topic)
        continue
      }
      if (action === 'wait') {
        if (!deferred.has(topic)) {
          log(`update: topic ${topic} "${st.name}" runs claude ${claude?.version} (${claude?.activity}); restarting onto ${installed} once idle`)
        }
        deferred.add(topic)
        continue
      }
      deferred.delete(topic)
      attempted.set(topic, installed)
      killSession(st, topic)
      // A start that fails has already said so in the topic, and the next message retries it
      const resumed = action === 'restart' && ensureSession(topic) === 'spawned'
      if (resumed) {
        void sayIn(
          String(GROUP_CHAT_ID),
          topic,
          `♻️ updated to Claude Code ${installed}: same conversation, resumed on the new version.`,
        )
      }
      saveRegistry()
      log(
        `update: topic ${topic} "${st.name}" ${resumed ? 'restarted and resumed' : 'stopped; resumes on its next message'} ` +
        `(claude ${claude?.version} -> ${installed})`,
      )
    }
  }

  return { sweep }
}
