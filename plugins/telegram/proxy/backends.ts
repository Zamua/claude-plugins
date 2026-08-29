/**
 * AgentBackend port: what the proxy needs to know about the HARNESS a topic
 * session runs on.
 *
 * The proxy core (proxy.ts) is harness-agnostic: it owns the Telegram poll,
 * the queues, the registry and the spawn lifecycle, and asks a backend for
 * the harness-specific artifact - the pane's env vars. Two adapters:
 *
 *   claude    the original topic-Claude (channel injection via the telegram
 *             MCP, `--session-id` / `--resume` continuity). Its outputs here
 *             are a VERBATIM extraction of what proxy.ts used to inline in
 *             ensureSession / kickoffPrompt; backends.test.ts pins them.
 *   opencode  an opencode TUI session driven by
 *             opencode-plugin/telegram-channel.ts (`--session <id>`;
 *             fresh sessions are adopted and POSTed to /oc-session).
 *
 * The first message a session gets is also backend-specific: claude carries
 * its startup notice in TG_KICKOFF (the launcher uses it only on a minting
 * spawn), opencode carries TG_OC_SEED (the handoff delta, or opencodeKickoff).
 * Both are passed in through the SpawnSpec the proxy builds.
 *
 * This module is PURE (no bot, no ports, no filesystem): it is importable by
 * bun test without booting anything, the same contract as secret.ts.
 */

export type BackendKind = 'claude' | 'opencode'

/** Everything a backend may need to build its spawn env + first message. */
export type SpawnSpec = {
  topic: string
  /** Topic display name (the Telegram label). */
  label: string
  /** Mux session name (recorded in st.session; `claude-...` / `oc-...`). */
  sessionName: string
  muxKind: 'tmux' | 'herdr'
  spawnDir: string
  proxyUrl: string
  /** The #square thread id, '' = disabled. */
  squareTopic: string
  // ---- claude-specific ----
  marketplace: string
  /** Value for the `--model` FLAG ('' = account default). */
  model: string
  claudeSessionId: string
  resume: boolean
  settingsPath: string
  stopHook: string
  failoverHook: string
  /** claude: the startup notice (present even on resume; unused by the launcher then). */
  kickoff: string
  // ---- opencode-specific ----
  /** '' = fresh TUI spawn; the plugin adopts and POSTs its session id. */
  opencodeSessionId: string
  /** Absolute opencode binary, resolved by the proxy (pane PATH is unreliable). */
  opencodeBin: string
  opencodeModel: string
  opencodeVariant: string
  /**
   * First prompt for the plugin's next run: a handoff delta (carried until the
   * plugin acks it), or the startup notice on a fresh topic. Empty = none.
   */
  opencodeSeed: string
}

export interface AgentBackend {
  readonly kind: BackendKind
  /**
   * Env vars for the launcher pane, MERGED over the proxy's own process.env.
   * Pure addition - the proxy never lets a backend unset or shadow its own vars.
   */
  spawnEnv(spec: SpawnSpec): Record<string, string>
}

// ---- claude -----------------------------------------------------------------
//
// VERBATIM extraction of the former ensureSession env block + kickoffPrompt.
// Any edit here must keep backends.test.ts's snapshots in mind: they pin the
// exact strings the live proxy has been spawning for months.

function claudeKickoff(spec: SpawnSpec): string {
  return (
    `SYSTEM STARTUP NOTICE (not a user message): you are the Claude for the ${spec.label} topic. ` +
    `Do NOT greet or send anything yet. Wait for the first real user message - it will arrive as a ` +
    `<channel> turn - and respond to THAT via the telegram MCP (it targets this topic). Your working ` +
    `dir is ${spec.spawnDir}. IMPORTANT: other Claudes may be running concurrently on this same machine, ` +
    `un-sandboxed and possibly in overlapping dirs, so be careful with destructive or global actions ` +
    `and with shared state, and do not assume you are alone. ` +
    // The operator's global CLAUDE.md carries this, but it is one rule in a
    // 100k-char file and was reliably ignored; restating it here puts it in
    // the session's first turn instead.
    `WRITING STYLE: never use em dashes in anything you write - not in messages to the user, ` +
    `not in code comments, commit messages, or docs. Use a colon, parentheses, or two sentences.` +
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

export const claudeBackend: AgentBackend = {
  kind: 'claude',

  spawnEnv(spec) {
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
      // A topic failed over by handleRateLimit keeps its fallback model on
      // every respawn until the nightly restart clears it.
      TG_MODEL: spec.model,
      TG_KICKOFF: claudeKickoff(spec),
      TG_CLAUDE_SESSION_ID: spec.claudeSessionId,
      TG_RESUME: spec.resume ? '1' : '',
    }
  },
}

// ---- opencode ---------------------------------------------------------------

/** What the framing functions need: the topic identity + working dir. */
export type SeedContext = { label: string; spawnDir: string; squareTopic: string }

export function opencodeKickoff(ctx: SeedContext): string {
  return (
    `SYSTEM STARTUP NOTICE (not a user message): you are the assistant for the ${ctx.label} topic, ` +
    `running in opencode. Do NOT greet or send anything yet. Wait for the first real user message - ` +
    `it will arrive as a <channel> turn - and respond to THAT via the telegram MCP reply tool ` +
    `(pass the chat_id from the inbound block; it targets this topic). Your working dir is ` +
    `${ctx.spawnDir}. CHANNEL DISCIPLINE: every <channel> turn MUST be answered through the telegram ` +
    `reply tool - transcript output never reaches the user. IMPORTANT: other agents may be running ` +
    `concurrently on this same machine, ` +
    `un-sandboxed and possibly in overlapping dirs, so be careful with destructive or global actions ` +
    `and with shared state, and do not assume you are alone. ` +
    `WRITING STYLE: never use em dashes in anything you write - not in messages to the user, ` +
    `not in code comments, commit messages, or docs. Use a colon, parentheses, or two sentences.` +
    (ctx.squareTopic
      ? ` THE SQUARE: a shared #square topic hosts agent-to-agent conversations. To ask a peer agent ` +
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

/** Frames a rendered conversation delta for handing a topic OVER to opencode. */
export function opencodeHandoffSeed(ctx: SeedContext, delta: string): string {
  return (
    `SYSTEM HANDOFF NOTICE (not a user message): you are taking over the Telegram topic ` +
    `"${ctx.label}" from a Claude Code session whose usage limit was exhausted. The recent ` +
    `conversation follows below so you can continue seamlessly: pick up any unanswered message ` +
    `and answer it via the telegram reply tool (chat_id comes from the inbound <channel> block; ` +
    `transcript output never reaches the user). ` +
    `Your working dir is ${ctx.spawnDir}. ` +
    `WRITING STYLE: never use em dashes in anything you write. Use a colon, parentheses, or two sentences.` +
    (ctx.squareTopic
      ? ` The #square and its norms work exactly as described in your instructions; list_topics shows the peers.`
      : '') +
    `\n\n--- PRIOR CONVERSATION (oldest first, from the Claude Code session) ---\n\n${delta}`
  )
}

export const opencodeBackend: AgentBackend = {
  kind: 'opencode',

  spawnEnv(spec) {
    return {
      TG_SESSION: spec.sessionName,
      TG_MUX: spec.muxKind,
      TG_SPAWN_DIR: spec.spawnDir,
      TELEGRAM_TOPIC_ID: spec.topic,
      TELEGRAM_PROXY_URL: spec.proxyUrl,
      TG_BACKEND: 'opencode',
      // Absolute path: opencode commonly lives outside the pane's PATH (a nix
      // per-user profile on this box), and a missed resolution kills the pane.
      TG_OC_BIN: spec.opencodeBin,
      // The registry session id: the launcher opens the TUI with `--session`
      // when present; empty = fresh topic, the plugin adopts the new session.
      TG_OC_SESSION_ID: spec.opencodeSessionId,
      // Pane-mode gates: OUTBOUND_ONLY puts the injected telegram MCP into
      // outbound-only mode (the plugin owns /poll); CHANNEL activates the
      // telegram-channel plugin in this opencode instance and nothing else.
      TELEGRAM_OUTBOUND_ONLY: '1',
      TELEGRAM_CHANNEL: '1',
      // A pending handoff delta or the startup notice: the plugin injects it
      // as the session's first prompt and acks it (POST /oc-seed-done), so it
      // rides every spawn until acked - minting or resumed alike.
      TG_OC_SEED: spec.opencodeSeed,
    }
  },
}

export function backendFor(kind: BackendKind | undefined): AgentBackend {
  return kind === 'opencode' ? opencodeBackend : claudeBackend
}

// ---- handoff delta plumbing -------------------------------------------------
//
// Rendering a conversation delta is backend-shaped but harness-free: the
// readers turn a serialized transcript into turns, renderDelta bounds them,
// and opencodeHandoffSeed frames them. The PROXY does the I/O (reading the
// claude jsonl, shelling out to `opencode export`) and passes the text in, so
// this stays testable with fixtures.

export type DeltaTurn = { role: 'user' | 'assistant'; text: string }

/**
 * Parse a Claude Code session transcript (the .jsonl under
 * ~/.claude/projects/<munged-cwd>/<session-id>.jsonl) into user/assistant text
 * turns. Tool calls/results, snapshots and non-message lines are skipped.
 * Keeps the NEWEST `maxTurns` turns.
 */
export function claudeTranscriptTurns(jsonl: string, maxTurns: number): DeltaTurn[] {
  const turns: DeltaTurn[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue // tolerate a torn tail line
    }
    if (o?.type !== 'user' && o?.type !== 'assistant') continue
    if (o.isSidechain || o.isMeta) continue
    const role = o.type as 'user' | 'assistant'
    const c = o.message?.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = c
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
    }
    text = text.trim()
    if (!text) continue
    turns.push({ role, text })
  }
  return turns.slice(-maxTurns)
}

/**
 * Parse `opencode export <sessionID>` output (JSON: {info, messages}) into
 * turns. Each message is {info: {role}, parts: [{type: 'text', text}, ...]}.
 * Keeps the NEWEST `maxTurns` turns.
 */
export function parseOpencodeExport(exported: string, maxTurns: number): DeltaTurn[] {
  const turns: DeltaTurn[] = []
  let d: any
  try {
    d = JSON.parse(exported)
  } catch {
    return turns
  }
  for (const m of d?.messages ?? []) {
    const role = m?.info?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = (Array.isArray(m?.parts) ? m.parts : [])
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n')
      .trim()
    if (!text) continue
    turns.push({ role, text })
  }
  return turns.slice(-maxTurns)
}

/**
 * Render turns oldest-first; if the render exceeds maxChars, drop the OLDEST
 * turns until it fits and mark the omission. Newest turns are the ones that
 * matter most for continuing a conversation.
 */
export function renderDelta(turns: DeltaTurn[], maxChars: number): string {
  const render = (ts: DeltaTurn[]) => ts.map(t => `[${t.role}]\n${t.text}`).join('\n\n')
  let kept = turns
  while (kept.length > 0 && render(kept).length > maxChars) kept = kept.slice(1)
  const body = render(kept)
  if (!body) return '(no conversation turns recovered)'
  const omitted = kept.length < turns.length ? '[...earlier turns omitted...]\n\n' : ''
  return omitted + body
}
