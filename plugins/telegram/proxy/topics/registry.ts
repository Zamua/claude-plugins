// registry.json: each topic's conversation, session and route, saved after every
// change and reconciled against the live multiplexer at boot.
import { readRegistryFile, writeRegistryFile } from '../adapters/registry-file'
import type { Registry } from '../adapters/registry-file'
import { DEFAULT_TOPIC_ROUTE, REGISTRY_FILE, TOPIC_LAUNCH_PROFILE_VERSION } from '../config'
import { launchProfileNeedsRefresh } from '../domain/launch-profile'
import { topicRouteFromRecord } from '../domain/model-routing'
import type { PendingRouteChange, TopicRoute } from '../domain/model-routing'
import { log } from '../log'
import { mux } from './mux'
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
    out[topic] = {
      tmux_session: st.session,
      thread_id: st.threadId ?? null,
      name: st.name,
      spawned_at: st.spawnedAt,
      claude_session_id: st.claudeSessionId,
      route: st.route ?? DEFAULT_TOPIC_ROUTE,
      ...(st.launchProfileVersion !== undefined
        ? { launch_profile_version: st.launchProfileVersion }
        : {}),
      ...(st.pendingRoute ? { pending_route: st.pendingRoute } : {}),
      ...(st.exhaustedRoutes.length ? { exhausted_routes: st.exhaustedRoutes } : {}),
      ...(st.pendingResumeNotice ? { pending_resume_notice: st.pendingResumeNotice } : {}),
    }
  }
  writeRegistryFile(REGISTRY_FILE, out)
}

// Load the registry and RECONCILE against the live tmux sessions: re-adopt
// entries whose session is still up (so a proxy restart re-adopts live
// sessions) and forget the rest (dead sessions).
export function loadAndReconcileRegistry(): void {
  const raw = readRegistryFile(REGISTRY_FILE, log)
  const live = mux.liveSessions()
  for (const [topic, entry] of Object.entries(raw)) {
    const st = getTopic(topic)
    st.threadId = entry.thread_id ?? undefined
    st.name = entry.name
    st.claudeSessionId = entry.claude_session_id ?? undefined
    st.route = routeFromRegistry(entry.route)
    st.launchProfileVersion = entry.launch_profile_version ?? undefined
    st.pendingRoute = pendingRouteFromRegistry(entry.pending_route)
    st.exhaustedRoutes = Array.isArray(entry.exhausted_routes)
      ? entry.exhausted_routes.flatMap(route => {
          const parsed = topicRouteFromRecord(route)
          return parsed ? [parsed] : []
        })
      : []
    st.pendingResumeNotice = entry.pending_resume_notice ?? undefined
    if (entry.name) topicNames.set(topic, entry.name)
    if (entry.tmux_session && live.has(entry.tmux_session)) {
      st.session = entry.tmux_session
      st.spawnedAt = entry.spawned_at
      const refresh = launchProfileNeedsRefresh(
        st.launchProfileVersion,
        TOPIC_LAUNCH_PROFILE_VERSION,
        entry.route,
        st.route,
      )
      if (refresh && !st.pendingRoute) {
        st.pendingRoute = {
          route: st.route,
          reason: 'migration',
          requestedAt: Date.now(),
        }
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
      st.session = ''
      st.spawnedAt = 0
      log(`topic ${topic} "${entry.name}" not live; will resume claude session ${entry.claude_session_id ?? '(none)'} on next message`)
    }
  }
  saveRegistry()
}
