// registry.json: each topic's conversation, session and route, saved after every
// change and reconciled against the live multiplexer at boot.
import { readRegistryFile, writeRegistryFile } from './registry-file'
import type { Registry } from './registry-file'
import { DEFAULT_TOPIC_ROUTE, EXTERNAL_TOPICS, REGISTRY_FILE, TOPIC_LAUNCH_PROFILE_VERSION } from '../config'
import { launchProfileNeedsRefresh } from './domain/launch-profile'
import { topicRouteFromRecord } from '../routing/domain/model-routing'
import type { PendingRouteChange, TopicRoute } from '../routing/domain/model-routing'
import { log } from '../log'
import { muxes } from './mux'
import { nextAgent } from './domain/agent'
import { sessionNodeFrom } from './domain/session-tree'
import { nextRoute } from '../routing/domain/route-flow'
import { getTopic, topicNames, topics } from './state'

function routeFromRegistry(value: unknown, fallback = DEFAULT_TOPIC_ROUTE): TopicRoute {
  return topicRouteFromRecord(value) ?? fallback
}

function pendingRouteFromRegistry(value: unknown): PendingRouteChange | undefined {
  const raw = value as any
  if (!raw || !['manual', 'quota', 'reset', 'migration'].includes(raw.reason)) return undefined
  const route = topicRouteFromRecord(raw.route)
  if (!route) return undefined
  return {
    route,
    reason: raw.reason,
    requestedAt: Number(raw.requestedAt) || Date.now(),
  }
}

export function saveRegistry(): void {
  const out: Registry = {}
  for (const [topic, st] of topics) {
    // Persist any topic that has been spawned at least once (has a Claude
    // session id, needed to resume the SAME conversation on the next
    // message) OR that has a known NAME with no session yet (a proxy-created
    // topic, registered at creation time; without persisting it here a proxy
    // restart would make it invisible again until a human messaged it).
    if (!st.claudeSessionId && !st.name) continue
    const running = st.agent.state === 'running' ? st.agent : undefined
    out[topic] = {
      tmux_session: running?.session ?? '',
      thread_id: st.threadId ?? null,
      name: st.name,
      spawned_at: running?.since ?? 0,
      claude_session_id: st.claudeSessionId,
      route: st.routing.route,
      ...(running?.profile !== undefined ? { launch_profile_version: running.profile } : {}),
      ...(st.routing.pending ? { pending_route: st.routing.pending } : {}),
      ...(st.routing.exhausted.length ? { exhausted_routes: st.routing.exhausted } : {}),
      ...(st.routing.resumeNotice ? { pending_resume_notice: st.routing.resumeNotice } : {}),
      ...(st.session ? { session: { parent: st.session.parent, spawned_by: st.session.spawnedBy, spawned_at: st.session.spawnedAt } } : {}),
      ...(st.archivedAt ? { archived_at: st.archivedAt } : {}),
    }
  }
  writeRegistryFile(REGISTRY_FILE, out)
}

// Load the registry and RECONCILE against the live tmux sessions: re-adopt
// entries whose session is still up (so a proxy restart re-adopts live
// sessions) and forget the rest (dead sessions).
export function loadAndReconcileRegistry(): void {
  const raw = readRegistryFile(REGISTRY_FILE, log)
  const live = muxes.liveSessions()
  for (const [topic, entry] of Object.entries(raw)) {
    const st = getTopic(topic)
    st.threadId = entry.thread_id ?? undefined
    st.name = entry.name
    st.claudeSessionId = entry.claude_session_id ?? undefined
    st.session = sessionNodeFrom(entry.session)
    st.archivedAt = typeof entry.archived_at === 'string' ? entry.archived_at : undefined
    const pending = pendingRouteFromRegistry(entry.pending_route)
    st.routing = {
      route: routeFromRegistry(entry.route),
      ...(pending && { pending }),
      exhausted: Array.isArray(entry.exhausted_routes)
        ? entry.exhausted_routes.flatMap(route => {
            const parsed = topicRouteFromRecord(route)
            return parsed ? [parsed] : []
          })
        : [],
      ...(entry.pending_resume_notice && { resumeNotice: entry.pending_resume_notice }),
    }
    if (entry.name) topicNames.set(topic, entry.name)
    // A session run outside the proxy is never adopted, so nothing here can stop or restart it.
    const isLive = !EXTERNAL_TOPICS.has(topic) && !!entry.tmux_session && live.has(entry.tmux_session)
    st.agent = nextAgent(st.agent, {
      type: 'restored',
      session: entry.tmux_session ?? '',
      since: entry.spawned_at ?? 0,
      ...(entry.launch_profile_version != null && { profile: entry.launch_profile_version }),
      live: isLive,
    }).agent
    if (isLive) {
      const refresh = launchProfileNeedsRefresh(
        entry.launch_profile_version ?? undefined,
        TOPIC_LAUNCH_PROFILE_VERSION,
        entry.route,
        st.routing.route,
      )
      const refreshed = refresh ? nextRoute(st.routing, { type: 'profile-stale', now: Date.now() }) : undefined
      if (refreshed?.outcome === 'queued') {
        st.routing = refreshed.flow
        log(
          `live topic ${topic} "${entry.name}" has a stale launch profile; ` +
          `queued same-UUID refresh at the next safe turn boundary`,
        )
      } else {
        log(`re-adopted live topic ${topic} "${entry.name}" (${entry.tmux_session})`)
      }
    } else {
      // Session is dead, but KEEP the claude session id so the next message
      // re-spawns and --resumes the SAME conversation instead of starting fresh.
      log(`topic ${topic} "${entry.name}" not live; will resume claude session ${entry.claude_session_id ?? '(none)'} on next message`)
    }
  }
  saveRegistry()
}

/**
 * Records a topic's new name, from Telegram's rename or the app's. The session
 * takes `claude-<new-slug>-<tid>` on its next respawn, never mid-life.
 */
export function learnTopicName(topic: string, name: string): void {
  topicNames.set(topic, name)
  const st = topics.get(topic)
  if (st) {
    st.name = name
    saveRegistry()
  }
}

