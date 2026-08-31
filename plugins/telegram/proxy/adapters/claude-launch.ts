import type { TopicRoute } from '../domain/model-routing'
import { autoCompactWindow } from '../domain/model-routing'
import { inboundModeForRoute } from '../domain/inbound-delivery'

export type ClaudeSpawnSpec = {
  topic: string
  label: string
  sessionName: string
  muxKind: 'tmux' | 'herdr'
  spawnDir: string
  proxyUrl: string
  squareTopic: string
  marketplace: string
  route: TopicRoute
  auxiliaryModel: string
  claudeSessionId: string
  resume: boolean
  settingsPath: string
  stopHook: string
  failoverHook: string
  capacityHook: string
  authorizationHook: string
  providerProxyUrl: string
  modelContextWindow?: number
}

function kickoff(spec: ClaudeSpawnSpec): string {
  return (
    `SYSTEM STARTUP NOTICE (not a user message): you are the Claude for the ${spec.label} topic. ` +
    `Do NOT greet or send anything yet. Wait for the first real user message - it will arrive as a ` +
    `<channel> turn - and respond to THAT via the telegram MCP (it targets this topic). Your working ` +
    `dir is ${spec.spawnDir}. IMPORTANT: other Claudes may be running concurrently on this same machine, ` +
    `un-sandboxed and possibly in overlapping dirs, so be careful with destructive or global actions ` +
    `and with shared state, and do not assume you are alone. ` +
    `WRITING STYLE: never use em dashes in anything you write - not in messages to the user, ` +
    `not in code comments, commit messages, or docs. Use a colon, parentheses, or two sentences.` +
    ` APPROVALS: auto mode may deny a tool action. The Telegram bridge will offer that exact action ` +
    `to the operator. Do not suggest SSH, /permissions, or a classifier workaround. If a later user ` +
    `turn explicitly approves an exact action once, retry only that exact action and let the normal ` +
    `auto-mode reviewer evaluate it again. If crash recovery repeats the same authorization request ` +
    `ID, do not retry it twice. Never broaden, split, encode, or otherwise disguise it.` +
    (spec.squareTopic
      ? ` THE SQUARE: a shared #square topic hosts agent-to-agent conversations. To ask a peer Claude ` +
        `for help, use the square_tag tool (see list_topics for peers); continue conversations with ` +
        `square_reply using the conv + reply_token from the notification meta. Norms: tag a peer only ` +
        `when you genuinely need them; every message must move the work forward; do long work in shared ` +
        `files and post summaries + paths; a closing courtesy is fine but never reply to a courtesy with ` +
        `a courtesy; if a square notification warrants no reply, do nothing - silence politely ends a ` +
        `conversation and is explicitly sanctioned there (the reply requirement applies to YOUR topic's ` +
        `user messages, not square deliveries).`
      : '')
  )
}

function bridgeModel(model: string): string {
  return /\[[^\]]+\]$/.test(model) ? model : `${model}[1m]`
}

function providerLaunchProfile(
  route: TopicRoute,
  auxiliaryModel: string,
  modelContextWindow?: number,
): {
  model: string
  auxiliaryModel: string
  autoCompactWindow: string
} {
  if (route.provider === 'codex') {
    return {
      model: bridgeModel(route.model),
      auxiliaryModel: bridgeModel(auxiliaryModel),
      autoCompactWindow: String(autoCompactWindow(route.provider, modelContextWindow)),
    }
  }

  if (route.provider === 'opencode-go') {
    return {
      model: route.model,
      auxiliaryModel,
      autoCompactWindow: String(autoCompactWindow(route.provider, modelContextWindow)),
    }
  }

  return {
    model: route.model,
    auxiliaryModel,
    autoCompactWindow: '',
  }
}

export function claudeSpawnEnv(spec: ClaudeSpawnSpec): Record<string, string> {
  const proxied = spec.route.provider !== 'anthropic'
  const profile = providerLaunchProfile(spec.route, spec.auxiliaryModel, spec.modelContextWindow)
  return {
    TG_SESSION: spec.sessionName,
    TG_MUX: spec.muxKind,
    TG_SPAWN_DIR: spec.spawnDir,
    TELEGRAM_TOPIC_ID: spec.topic,
    TELEGRAM_PROXY_URL: spec.proxyUrl,
    TG_MARKETPLACE: spec.marketplace,
    TG_SETTINGS: spec.settingsPath,
    TG_HOOK: spec.stopHook,
    TG_FAILOVER_HOOK: spec.failoverHook,
    TG_CAPACITY_HOOK: spec.capacityHook,
    TG_AUTHORIZATION_HOOK: spec.authorizationHook,
    TG_PROVIDER: spec.route.provider,
    TG_INBOUND_MODE: inboundModeForRoute(spec.route),
    TG_PROVIDER_BASE_URL: proxied ? spec.providerProxyUrl : '',
    TG_PROVIDER_AUTH_TOKEN: proxied ? 'unused' : '',
    TG_AUTO_COMPACT_WINDOW: profile.autoCompactWindow,
    TG_MODEL: profile.model,
    TG_AUX_MODEL: profile.auxiliaryModel,
    TG_EFFORT: spec.route.effort === 'auto' ? '' : spec.route.effort,
    TG_DISALLOWED_TOOLS: spec.route.ultracode ? 'AskUserQuestion' : 'AskUserQuestion,Workflow',
    TG_KICKOFF: kickoff(spec),
    TG_CLAUDE_SESSION_ID: spec.claudeSessionId,
    TG_RESUME: spec.resume ? '1' : '',
  }
}
