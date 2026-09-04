# telegram-topics: working notes

## What it is

A drop-in replacement for the single-session `telegram` channel that fans ONE
bot token out to MANY concurrent agent conversations, one per Telegram forum
topic. Ordinary topics are Claude Code sessions; a fresh topic can be explicitly
and permanently harness-locked to Google's official Antigravity CLI
(`/antigravity`) or to OpenCode on the local Qwen server (`/localcode`).
Forked from the official `telegram` plugin 0.0.6; the only real change is the
transport: the token + getUpdates + access logic moved OUT of the MCP into a
standalone proxy, and the MCP became a thin HTTP client of that proxy.

Drop-in identity (do NOT change these, they are load-bearing):
- plugin name `telegram`, MCP server name `telegram`
  -> tool ids stay `mcp__plugin_telegram_telegram__*`
  -> channel source stays `plugin:telegram:telegram`
- the four tools `reply` / `react` / `download_attachment` / `edit_message`
  keep their names + inputSchemas
- the MCP declares `experimental["claude/channel"] = {}` (plus
  `experimental["claude/channel/permission"] = {}`, same as the official) and
  ships the official `instructions` string byte-for-byte

## Architecture

```
Telegram forum group
   │  (one getUpdates poll, the ONLY consumer of the token)
   ▼
proxy/proxy.ts ── grammy inbound ── group-chat gate ── topic = message_thread_id | "general"
   │                                                    ├─ enqueue {content, meta}
   │                                                    ├─ Anthropic: MCP /poll -> native Channel
   │                                                    ├─ custom provider: idle-pane prompt adapter
   │                                                    └─ ensureSession() spawns a Claude
   │                                                       if none is live (single-flight)
   │  Bun.serve on 127.0.0.1:PORT
   ├── GET  /poll?topic=T             long-poll ~25s, 204 idle / 200 {content,meta}
   ├── GET  /permission-poll?topic=T  long-poll ~25s, 200 {request_id,behavior}
   ├── POST /send /react /edit /download   (keyed by topic -> message_thread_id)
   ├── POST /permission-request       {topic,request_id,tool,input} -> prompt in topic
   ├── POST /permission-denied        auto-mode hook -> durable exact-action approval
   └── GET  /health                   {ok, topics, port, polling, polling_since}

fresh `/antigravity` topic ── separate aggregate/repository ── persistent Herdr `agy`
   ├── live `agy models` catalog -> model -> effort Telegram picker
   ├── first interactive launch persists conversation_id + Herdr label
   ├── Telegram prompt -> Herdr agent prompt -> outbound-only Telegram MCP
   └── relaunch/model switch -> --conversation <same-id>

fresh `/localcode` topic ── separate aggregate/repository ── persistent Herdr `opencode`
   ├── single local model (qwen-local), no route, no usage
   ├── first launch persists the OpenCode session id + Herdr label
   ├── Telegram prompt -> Herdr agent prompt -> env-injected outbound-only Telegram MCP
   └── relaunch -> -s <same-session-id>

scripts/launch-topic.sh ── spawn in the selected multiplexer (TG_MUX: tmux new-session -d
   with vars via -e, or herdr agent start with vars via /usr/bin/env; see
   "Multiplexer backends") ── session claude-<slug>-<tid> ──
   exec claude --dangerously-load-development-channels=plugin:telegram@zamua
               --settings override-settings.json --permission-mode auto
               first spawn: --session-id <id> "<kickoff>"   (mints the session)
               re-spawn:    --resume <id>                    (no kickoff, keeps history)
   + a short-lived detached watcher answers the "local development" confirm dialog

hooks/permission-denied.py
   ├── PermissionDenied -> POST /permission-denied (never executes or retries a tool)
   └── SessionStart -> injects the exact-action approval/retry protocol as context

server.ts (the MCP, one per multiplexer session)
   ├── inbound     Anthropic only: long-poll GET /poll -> notifications/claude/channel
   │               (first poll held FIRST_POLL_DELAY_MS so the booting REPL is idle)
   ├── outbound    reply/react/edit/download -> POST to the proxy (each carries TOPIC)
   └── permission  DORMANT under --permission-mode auto (guard-checked auto-approve
                   raises no prompt for routine commands); retained for re-activation:
                   permission_request -> POST /permission-request;
                   long-poll GET /permission-poll -> notifications/claude/channel/permission
```

## Multiplexer backends (tmux | herdr)

The detached topic-Claudes are hosted by a terminal multiplexer, selectable via
`TELEGRAM_TOPICS_MULTIPLEXER=tmux|herdr` (default `tmux`; read at proxy boot).
The code follows a ports-and-adapters split so neither backend leaks into the
core:

- **The port** (`proxy/adapters/multiplexer.ts`): `interface MultiplexerPort
  { kind; liveSessions(); runtime(); prompt(); kill() }`. `runtime` and `prompt`
  provide safe idle-turn delivery for custom provider routes. `TmuxMux` shells
  to `tmux`; `HerdrMux`
  shells to `herdr pane list` (JSON; the pane `label` is our session name) /
  `herdr pane close <pane_id>`. Session NAMES are the shared currency: a tmux
  session name == a herdr agent/pane label (`claude-<slug>-<tid>`), so the
  registry (`tmux_session` field - name kept for back-compat, it stores "the
  mux session name") works unchanged for both.
- **Spawning** lives in `scripts/launch-topic.sh` (branch on `TG_MUX`, set by
  the proxy), because spawning is where the backend-specific ceremony is:
  - tmux: `new-session -e VAR=...` for env (see the env-propagation gotcha
    below), `capture-pane`/`send-keys` for the dialog watcher.
  - herdr: one WORKSPACE per topic-Claude (`workspace create --label <session>
    --no-focus`), whose auto-created ROOT pane hosts the agent; the pane is
    renamed to the session name (`pane rename`) because the pane LABEL is what
    the proxy and the dedup guard look sessions up by. The invocation is then
    written to a short-lived script under `$TMPDIR` and started with
    `herdr pane run <pane_id> "exec bash <script>"`. Three constraints force
    that shape: `herdr agent start` cannot launch an arbitrary command (as of
    0.8.2 it only types the KIND's own binary into an existing pane, `--kind K
    --pane ID`); `pane run` TYPES its argument into the pane shell, so a
    newline submits the line half-parsed and anything past ~1500 chars is
    dropped without ever being submitted; and a herdr pane inherits the herdr
    SERVER's environment - often a minimal launchd one - never the launcher's,
    so every var including PATH must be exported by that script or `claude`
    may not even resolve. The script deletes itself on entry (bash holds the
    open fd). The dialog watcher polls the socket API (`pane.read`,
    newline-delimited JSON over `~/.config/herdr/herdr.sock`; NB `source` is
    required and must be `visible`) and answers with
    `herdr pane send-keys <pane_id> 1 Enter`.
  - **Subagent poller guard** (`server.ts`): a background agent spawned by a
    topic-Claude (Agent tool / claude daemon) inherits the pane env -
    `TELEGRAM_TOPIC_ID` included - and loads this plugin, which would make it
    a SECOND poller round-robining the topic's queue (observed 2026-07-18).
    Bg sessions are identified by `CLAUDE_CODE_SESSION_KIND=bg`; they keep the
    outbound tools but never start the inbound/permission polls.
  - The claude invocation (`PANE_CMD`) is byte-identical for both backends.

**herdr prerequisites:** (1) the herdr server must be running - e.g. a launchd
agent with `ProgramArguments: [herdr, server]`, `KeepAlive: true` (herdr is
`brew install herdr`); (2) on macOS, grant Full Disk Access to the herdr BINARY
(System Settings -> Privacy & Security -> FDA -> `/opt/homebrew/bin/herdr`) if
topic-Claudes need protected paths - the multiplexer server is the TCC
"responsible process" for everything under it, exactly like tmux is on the tmux
backend; (3) one herdr server crash takes ALL its panes down together (unlike
independent tmux sessions) - KeepAlive + the proxy's respawn-on-next-message
covers recovery, and each topic `--resume`s its same conversation.

**herdr liveness: a LABEL IS NOT A LIVE SESSION (logout/login recovery).** herdr
persists its layout (`session.json`) and RESTORES panes when the server comes
back - so after a logout/login (or any herdr restart) the topic panes reappear
with their labels intact while the claude process inside them is DEAD. herdr
reports such an empty shell as `agent_status: "unknown"`; a real agent is
`idle`/`working`/`done`/`blocked`. Both the proxy's `HerdrMux.liveSessions()` and
the launcher's `spawn_herdr` dedup guard therefore require a NON-`unknown` status,
not merely a label. With the old label-only checks, exactly the topics that were
RUNNING at logout could never come back: the proxy "re-adopted" the corpse on boot
and never respawned, and even if it had tried, the launcher refused to spawn over
the existing label - messages queued for a session that did not exist. (Diagnosed
2026-07-23: `claude-general` + `claude-macos-944` were labeled panes with
`agent_status: "unknown"` and zero claude processes.) A stale labeled pane is now
CLOSED by the launcher before spawning, so no duplicate label is stranded.
Caveat baked in: `unknown` is also reported for the first ~2s of a healthy pane's
life, so `ensureSession` honors `SPAWN_GRACE_MS` (30s) after a spawn - otherwise a
message arriving during boot would spawn a second agent on top of the first.

**Switching backends** (either direction): set the env, restart the proxy.
Live sessions in the OLD backend keep running and stay re-adopted via the
registry, but the selected backend cannot see or kill them - so drain them
deliberately: kill each old-backend session yourself; the topic's next inbound
message respawns it (same `claude_session_id` -> same conversation) in the new
backend. Zero message loss either way (the proxy, not the sessions, owns the
Telegram poll).

## The square (inter-Claude collaboration)

One designated forum topic hosts ALL agent-to-agent conversations
(`TELEGRAM_TOPICS_SQUARE_TOPIC_ID` = its thread id; unset = feature off, all
square endpoints/tools error, nothing else changes). Full design + rationale:
the "square-design" doc (private rooms + one commons; addressed delivery,
never broadcast; behavioral discipline, no caps).

- **Tools** (`server.ts`): `list_topics` (directory: slug/name/live),
  `square_tag(peer, text)` (open a conversation), `square_reply(conv,
  reply_token, text)` (continue one; conv + reply_token come VERBATIM from the
  notification meta). Claudes cannot post to the square any other way - a
  generic reply aimed at it is rejected.
- **Proxy endpoints**: `GET /topics`, `POST /square/tag`, `POST /square/reply`.
  Validation: unknown peer 400, unknown conv 404 ("use square_tag"),
  non-participant 403, missing/garbled reply_token threads to the conv ROOT
  (safe fallback - a stray unthreaded message is not expressible).
- **Delivery**: recipient set = conversation participants (or freshly tagged
  peers) minus the author; NEVER broadcast. Delivery wakes a dormant peer via
  `ensureSession` (a tag counts as a first message). Every delivered content
  carries the standing SQUARE_NORM line ("reply only if it moves the work
  forward... silence politely ends a conversation"). Depth is tracked
  (logged + in the meta) but never enforced; a HUMAN message in a chain
  resets it to 0. No rate limits: Telegram's per-group limit is the only
  throttle (grammy backoff-retries 429s).
- **State**: `conversations.json` beside registry.json - conv id (= root
  message id in the square thread) → {participants, last_msg_id,
  origin_topic, depth, updated_at}. Atomic writes, cap 50 LRU, TTL
  `TELEGRAM_TOPICS_CONV_TTL_HOURS` (48). Durable across restarts AND lazily
  rederivable: every non-root square message header carries `#<conv>`, so an
  operator reply's `reply_to_message` lets the proxy rebuild a lost entry.
- **Operator messages in the square** route by the same rules: reply within a
  chain (resets depth, delivered to participants) or @tag claudes (opens a
  conv); untagged non-replies are delivered to no one.
- **Reply-guard exemption**: `stop-reply-guard.py` lets a square-triggered
  turn (`square="1"` in the channel meta) end WITHOUT a reply - silence is
  sanctioned there; nagging would manufacture the courtesy-loop the norms
  exist to prevent. Verified live: the first end-to-end test had claude B
  answer a question and claude A correctly stay silent on receiving it.
- **Breadcrumbs**: `square_tag` posts `↪️ asked @peer in #square: <t.me deep
  link>` into the initiating claude's own topic (link form
  `t.me/c/<chat-sans--100>/<square-tid>/<msg-id>`).
- **Bot-created topics + the `create_topic` tool**: Telegram never delivers a
  bot's own actions via getUpdates, so a topic created by raw
  `createForumTopic` emits no learnable forum_topic_created and stays
  invisible until a human messages it. FIX: route creation through the proxy
  (`POST /topic/create` / the `create_topic` MCP tool) - the API RESPONSE
  carries the thread id, so the proxy registers + persists the topic at
  creation time (registry.json now also persists name-only, never-spawned
  topics for exactly this reason). A proxy-created topic is in the directory
  and taggable immediately; its claude spawns on first message or tag. Only
  topics created OUTSIDE the proxy still need a first human message.

## Voice-note auto-transcription

Inbound voice messages (attachment_kind `voice`) are transcribed by the PROXY
before enqueue: download via getFile -> ffmpeg to 16k mono wav -> whisper-cli
(whisper.cpp, github.com/ggml-org/whisper.cpp) with the large-v3-turbo q5 model
at `~/.local/share/whisper-models/`. On success the channel content becomes
`[voice note, auto-transcribed; may contain errors]\n<text>` (caption, when
present, prefixed) and the meta carries `voice_transcribed: "1"`. FAIL-OPEN:
missing ffmpeg/whisper-cli/model, a subprocess error, a timeout (30s convert /
120s transcribe), or empty output -> the plain "(voice message)" content ships
with attachment meta intact, so the manual download+transcribe path keeps
working. Subprocesses run via async execFile so a long clip cannot stall the
event loop serving /poll; temp wav + oga are deleted after. Config:
`TELEGRAM_TOPICS_VOICE_TRANSCRIBE` (default on) + `_FFMPEG_BIN` /
`_WHISPER_BIN` / `_WHISPER_MODEL` path overrides (defaults are homebrew paths -
launchd's minimal PATH never resolves bare names). Model choice matters:
tiny/base/small all garbled a true WHISPER (low-energy speech); large-v3-turbo
transcribed it correctly (verified 2026-08-08). Telegram caps bot downloads at
20MB (~20 min of voice).

## Secret drop (`/secret <name>`)

The operator pastes a credential into any topic as `/secret <name>` with the
value on the next line (same line works too); `/secrets` shows names, sizes
and dates; `/unsecret <name>` removes one. Three flat verbs because Telegram's
"/" menu has no sub-commands and a phone keyboard turns `--` into an em dash;
the proxy registers them in the group's command menu at boot
(`registerSecretCommands`, `setMyCommands` scoped to the group). The
`/secret --list` and `/secret --delete <name>` flag forms remain as aliases,
and a flag also reads with an em or en dash. The PROXY handles all of it in
`handleSecretDrop`, before every relay path including the square, and the
message itself is never enqueued: a topic-Claude's transcript persists every
inbound message in plaintext, so the value must not reach one. Parsing and the
files live in `proxy/secret.ts` (pure, tested with `bun test`).

**The guided flow.** A menu tap sends the bare verb, so a bare `/secret` or
`/unsecret` opens a prompt exchange instead of failing with usage: the proxy
asks for the name (ForceReply, so the phone's reply box opens with a
placeholder), then for the value; `/unsecret` asks only for the name. The
state machine is pure (`beginSecretFlow` / `advanceSecretFlow` in
`secret.ts`); the proxy keeps the pending state in `pendingSecrets`, keyed by
user AND topic with a 5-minute TTL, so a stale flow can never swallow an
unrelated message. While a flow is pending, that user's next text in that
topic is consumed by the flow and never relayed. An existing name is bounced
at the NAME step (before any value is requested), `name --replace` opts in,
and "cancel" works at every step. Every message in the exchange, the prompts
included, is deleted; only the final ack stays.

Order of operations, and why: the message is DELETED from the chat first,
whatever happens next, so a refused name cannot leave the value on screen.
Then the sender is checked against `TELEGRAM_TOPICS_SECRETS_USER_ID` (unset =
feature off; the group gate alone admits every member). Then the name is
validated (`[a-z0-9][a-z0-9._-]{0,63}`, no `..`). An EXISTING name is refused
(the ack reports its size and the `/secret <name> --replace` form to resend),
because the directory holds live credentials and a mistyped name must not
clobber one; `--replace` counts only directly after the name, anywhere else it
is part of the value. The value is written to
`TELEGRAM_TOPICS_SECRETS_DIR/<name>` (default `~/keys`) as a 0600 temp file
renamed into place, with one trailing newline. The ack in the topic names the
path and byte count and says `replaced` on an opted-in overwrite; it never
carries the value. If the delete failed the ack says so, because the value is then
still in the chat and the operator must remove it. After a store or a delete
the topic's Claude is told through the normal queue (`ensureSession` +
`enqueue`, so a dormant one wakes): a `SYSTEM NOTICE` naming the path and byte
count, never the value, with meta `secret_drop=1`. The reply guard treats that
meta like a square turn and accepts silence, since the proxy already acked in
the topic. The square topic gets no notice; it has no Claude of its own.

Residual exposure is the one hop through Telegram's servers (the Bot API is
not end-to-end) and the client's own message cache until the delete lands.

## Relaunch (`/relaunch`)

A topic session is one long-lived agent process, and MCP servers and settings
load only at spawn, so a change to either needs a respawn. `/relaunch` in a
topic does exactly what the nightly restart and a provider-route change do,
on demand: `killSession` (which also drains the dying MCP's long-polls, so the
nudge cannot be handed to it and lost), a proxy ack in the thread, a `SYSTEM
NOTICE` enqueued with meta `relaunch=1`, then `ensureSession` respawns with
`--resume`. The notice asks for ONE line back naming the MCP servers the
session now sees, so a respawn that fails shows up as a visible silence and
the operator can read the reloaded config off the reply. The square gets a
refusal (no claude of its own). Registered in the group's "/" menu alongside
the secret verbs (`registerCommands`); any group member may run it, since it
is not destructive: the conversation resumes.

## Provider/model routing and quota recovery

For ordinary topics there is exactly one agent harness: foreground Claude Code.
Provider/model is a route below that harness:

```
Telegram topic -> Claude Code session UUID -> launch profile
                                      native Anthropic
                                      Codex via loopback bridge
                                      OpenCode Go via loopback bridge
```

`TopicRoute {provider, model, effort, ultracode}` is domain state persisted in
`registry.json`. `proxy/domain/` owns route validation and safe-turn-boundary
planning; `proxy/adapters/` owns provider catalogs, capacity reads, Codex
app-server JSON-RPC, OpenCode Go usage HTTP, and Claude launch environments.
The proxy/application layer coordinates those ports with Telegram and the
multiplexer. The Claude UUID never changes when the route changes.

Inbound delivery is also route state. Anthropic uses the MCP's native Channel
notification path. Claude Code reports `Channels are not currently available`
under the custom API-billing mode used by the compatibility bridge, and silently
drops those notifications. Codex/OpenCode routes therefore disable MCP inbound
polling (`TG_INBOUND_MODE=pane`) and the proxy renders the same Telegram
`<channel>` envelope into the idle foreground Claude pane through the
multiplexer port. The Telegram MCP remains loaded for replies and attachments.
This changes transport only: it does not fork the UUID, replace Claude Code, or
introduce another harness.

Herdr's aggregate `working` state can remain set while background workflows run
even though Claude's blank foreground `❯` prompt is ready. The Herdr adapter
checks that prompt explicitly and uses the pane's atomic run operation for this
case, so background agents do not starve Telegram delivery. A non-empty prompt,
active foreground turn, or approval dialog remains non-promptable.

The operator runs `/model` proactively: provider buttons -> model buttons ->
effort buttons -> Ultracode on/off. The effort step is always shown; models
without selectable variants use `auto` (shown as “Provider default”). Ultracode
is per-topic and defaults off. Turning it on forces xhigh effort and dynamic
workflow orchestration; the picker offers it only for compatible models.
`/model status` shows the active route plus its enforced subagent, auxiliary,
effort, and Workflow policy. `/usage` shows observed quota windows and reset
times. A route change while Claude is idle is applied immediately; one requested
during a turn is persisted as `pending_route` and applied when the old process
polls again after finishing the turn.

Quota recovery is deliberately operator-driven:

1. `hooks/rate-limit-failover.py` reports a StopFailure `rate_limit` to
   `POST /rate-limit`.
2. The proxy marks the current provider exhausted, stops the stalled process,
   and posts provider buttons in that topic. It does not silently choose or
   consume a reset credit.
3. After provider, model, effort, and Ultracode are selected, the launcher starts Claude Code
   with `--resume <the-same-uuid>` and the new launch profile. A durable
   `pending_resume_notice` tells it to answer the most recent unanswered user
   message; that notice is cleared only after its active inbound adapter accepts
   it.
4. Provider capacity adapters keep watching reset windows. When the exhausted
   provider becomes available, the proxy offers “switch back” and “choose
   model” buttons. It never switches back automatically. The direct switch-back
   callback is stateless (`provider + topic`) and resolves the exact prior route
   from `exhausted_routes`, so a service restart cannot expire it. The callback
   adapter also recognizes the older token-backed reset keyboard during migration.

Details that matter:

- Always kill through `killSession`, never `mux.kill` directly, before a nudge.
  It drains stale long-poll waiters so a notice cannot be handed to a dead MCP.
- Anthropic capacity is reported by `provider-capacity-status.py`; Codex is read
  from `codex app-server` (`model/list`, `account/rateLimits/read`); OpenCode Go
  is read from its authenticated usage endpoint. A missing probe is “not
  observed,” never assumed available.
- Every topic launch pins `CLAUDE_CODE_SUBAGENT_MODEL` to the Telegram-selected
  main model and, unless effort is `auto`, pins `CLAUDE_CODE_EFFORT_LEVEL` to
  the selected effort. Claude Code gives that environment variable precedence
  over subagent/workflow frontmatter, so a nested agent cannot silently raise
  medium to high/xhigh. When Ultracode is off, the launcher also denies the
  `Workflow` tool at the CLI boundary; turning Ultracode on is the only route
  that exposes it. `AskUserQuestion` stays denied because a detached pane cannot
  answer its terminal UI.
- Auxiliary work uses an efficient model from the same provider allowance:
  Anthropic Haiku, Codex GPT-5.6 Luna, or OpenCode Go GPT-5.6 Luna, with a
  catalog-aware fallback to the selected main model. The launcher exports the
  current `ANTHROPIC_DEFAULT_HAIKU_MODEL` and the legacy
  `ANTHROPIC_SMALL_FAST_MODEL` alias for compatibility. This auxiliary choice
  does not change the main or ordinary subagent model.
- Proxied routes set `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and
  `ANTHROPIC_MODEL` only in the spawned Claude environment. Codex models use the
  bridge's `[1m]` model suffix and a
  deliberate 272k auto-compact window (the long-context pricing boundary).
  OpenCode Go reads each installed model's actual context window from
  `opencode models opencode-go --verbose`, clamps it to Claude Code's 100k-1m
  accepted range, and falls back to 200k only when metadata is unavailable.
  This variable is the capacity used for compaction calculations, not the exact
  trigger; Claude Code still applies its normal near-capacity percentage.
  Native Anthropic leaves compaction provider-managed.
  The main and subagent model overrides are load-bearing for exact-UUID resumes:
  `--model` alone can leave an Anthropic-authenticated session on its restored
  native plan route. Native Anthropic explicitly unsets every bridge override.
- `scripts/start-provider-proxy.sh` enables
  `CCP_CODEX_PREVIOUS_RESPONSE_ID=1` by default. The bridge then sends only the
  new turn for an established Codex main-agent or direct-subagent stream and
  links it to the prior Responses API result. It keeps those chains separate by
  Claude session/agent headers and falls back to a full-context request whenever
  a safe continuation key is unavailable. Bridge restarts forget only this
  in-memory transport cache; Claude's UUID/transcript remains the source of
  truth, so the next request rebuilds context without forking the session.
- `claude-code-proxy` is an unofficial local compatibility bridge. It binds to
  loopback, owns no Telegram state, and receives the OpenCode credential at
  process start from OpenCode's existing auth file; the key is not copied into
  the plugin `.env`, PM2 config, or registry. The installed Nix derivation is
  source-pinned; review its new revision before upgrades. Normal request logging
  records metadata rather than prompt bodies, opt-in traffic capture stays off,
  and the start adapter applies `umask 077` plus mode `0600` to bridge state logs.
  The bridge still necessarily sees proxied prompts/tool payloads and provider
  credentials, and unofficial-client provider/account risk remains.
- The hook must stay compatible with the macOS Python used by the detached
  process. `from __future__ import annotations` keeps newer type syntax lazy.

## Harness-locked Antigravity topics

The one-harness statement above applies to ordinary topics. Antigravity is a
separate opt-in bounded context; it is never another value in Claude's
`ProviderId` or `TopicRoute`.

`/antigravity` may be run only by the configured admin and only in a fresh
topic with no Claude UUID/live pane. It creates an `AntigravityTopic` aggregate
in private, atomic `antigravity-topics.json` state. There is no unlock/conversion
path: keeping the harness identity explicit prevents a model name from silently
changing which runtime owns the conversation.

The runtime is Google's official authenticated `agy` CLI, not the unofficial
Claude provider bridge. `launch-antigravity-topic.sh` creates one visible Herdr
workspace per topic (`agy-<slug>-<threadid>`) and runs a persistent interactive
CLI under `--dangerously-skip-permissions`. `AntigravityTopicService` serializes
Telegram turns and injects each one through `herdr agent prompt`; the operator
can monitor or interact with that same pane directly. The first launch records
both the Herdr label and `conversation_id`; relaunch and model changes pass
exactly that id through `--conversation`. The adapter discovers the active id
from the `agy` process's open conversation database and refuses a mismatch, so
it cannot silently present a fork as continuity.

Antigravity loads the existing `server.ts` MCP as an outbound-only adapter. On
proxy boot, `antigravity-mcp-config.ts` atomically adds the `telegram-topics`
entry to `~/.gemini/config/mcp_config.json` while preserving user servers. The
Herdr launcher binds `TELEGRAM_TOPIC_ID`, `TELEGRAM_PROXY_URL`, and
`TG_INBOUND_MODE=pane`; therefore the MCP exposes reply/react/edit/download in
that pane but never starts a second Bot API poller. With no explicit topic (an
ordinary manual `agy` session), it exposes zero tools and stays dormant.

`/model` in a locked topic reads `agy models` dynamically (60-second cache),
groups concrete `-low`/`-medium`/`-high` variants into model then effort steps,
and emits only `agroute:*` callbacks. It has no provider step and no Ultracode.
Conversely, the Claude picker emits only `tgroute:*`. The callback boundary
checks both the callback namespace and Telegram thread id, so an old or forged
Claude-route button cannot mutate an Antigravity topic (and vice versa).
`/usage` runs Antigravity's native `/usage` command and reports only its
subscription pools. `/relaunch` closes and recreates the Herdr process with the
same conversation. A route switch does the same with the chosen model/effort.
Both changes queue while either a Telegram or direct Herdr turn is working, and
a short reconciliation interval applies them at the next idle boundary.

Configuration interop is explicit:

- Antigravity handles `AGENTS.md` and `GEMINI.md` natively.
- The first-turn compatibility context requires applicable project
  `CLAUDE.md` files, and relevant general guidance from `~/.claude/CLAUDE.md`,
  to be read as supplemental instructions while translating or ignoring
  clauses tied to Claude Channels, Claude hooks, Claude permissions, or the
  Claude harness itself. A channel turn must use the outbound Telegram MCP; a
  prompt typed directly in Herdr answers only there.
- On proxy boot, `antigravity-skill-interop.ts` safely links portable Markdown
  skills from `~/.agents/skills`, `~/.claude/skills`, and enabled Claude plugin
  `skills/` folders into `~/.gemini/antigravity-cli/skills`. A private manifest
  means it removes only links it previously created; native/user-managed
  Antigravity skills are preserved. Every plugin named `telegram` is excluded
  to protect the one Bot API poller.
- Claude manifests, hooks, custom agents, and channels are not claimed as
  portable. They need specific adapters. Antigravity-native plugin/MCP config
  remains independent.
- `antigravity-mcp-config.ts` adds only the outbound Telegram MCP entry to the
  native config and preserves every user-managed MCP server.

`--dangerously-skip-permissions` is intentional for this bounded context: the
operator requested no hard gates even while working unattended from Telegram.
It is not Claude's reviewer-backed auto mode and has no Terra
classifier; the topic should be treated as an unreviewed local agent.

## Harness-locked OpenCode (localcode) topics

`/localcode` is the Antigravity pattern applied to a third runtime: the OpenCode
TUI driving the local Qwen server (`qwen-local/Qwen3.8-27B`, the same thing the
operator's `localcode` alias runs by hand). It is a separate bounded context
(`proxy/domain/opencode-topic.ts`, `OpencodeTopicService`,
`HerdrOpencodeRuntime`, `opencode-topics.json`) and shares no abstraction with
Antigravity beyond the Telegram Bot API adapter. Same rules: admin only, a fresh
topic with no Claude UUID/live pane, never the square, no unlock or conversion
path. A topic locked to one harness refuses the other command, every Claude
spawn/queue/notice path skips a locked topic, and a square or action
authorization delivery aimed at one is dropped with a log line (no Claude pane
would drain that queue).

The runtime is one visible Herdr workspace per topic, `oc-<slug>-<threadid>`,
running `opencode <project dir> -m <model> --pure` with cwd = the project dir
(`TELEGRAM_OPENCODE_PROJECT_DIR`, whose `opencode.jsonc` defines the local
provider and whose `AGENTS.md` is the project instruction file). Session
identity is captured only from a launch the adapter itself started: a fresh
launch passes the kickoff as `--prompt`, waits for the pane to go idle, then
lists recent sessions (`opencode session list --format json -n 20`, cwd =
project dir) and requires exactly one created since launch (zero keeps polling
to the deadline; two or more closes the pane and fails, since the operator's
own manual session in the same project dir is indistinguishable). That id is
persisted and every later launch resumes it with `-s <id>`. On a resume the
adapter reads the id back out of the foreground `opencode` argv (`herdr pane
process-info`) and refuses a mismatch, so a fork can never be presented as
continuity. A live pane with no persisted id and no `-s` in argv is closed and
relaunched rather than inspected. Discovery runs at launch only, never per
turn. `/relaunch` closes and recreates
the pane with the same session (queued at the idle boundary while a turn is
working, like Antigravity).

A turn is settled only after the pane has stayed idle (or done) for a
continuous `OPENCODE_SETTLE_MS` (6 s, polled every second; any non-idle
observation restarts the window; blocked throws). Herdr reports the pane idle
between OpenCode tool calls, and `herdr agent prompt --wait` returns on the
first such report, so without the window the service dequeued the next
Telegram turn mid-turn and the injected prompt aborted the running one
(`MessageAbortedError`). The window applies both before delivery
(`waitUntilIdle`) and after `agent_prompted`, under the same 31-minute ceiling.

Reply backstop: OpenCode has no Stop hook, so a turn can end with nothing sent
(the model answers only in the terminal, or hits its 8192-token output cap
mid-reasoning with `finish: length`). `/send` records the last outbound time per
locked topic; when a turn ends with no send since it started, the service runs
`opencode export <session id>` (cwd = project dir), and posts the last assistant
message's text parts as a proxy notice prefixed `↩︎ ` (capped at 3500 chars).
No text and `finish: length` yields an output-limit notice; no export at all
yields a generic "finished without sending a reply". The backstop never fails
the turn; a failed notice goes through the error path.

`--pure` is load-bearing. The operator's global `tui.json` loads
`@leohenon/opencode-vim-plugin`, which puts the input box in vim normal mode, so
text injected by `herdr agent prompt` is eaten as vim commands (a leading `R`
enters replace mode and the prompt stalls). `--pure` skips external TUI plugins;
config-level MCP servers still load, so the Telegram MCP is unaffected.

The Telegram MCP is injected through the environment, never through a config
file: `launch-opencode-topic.sh` exports `OPENCODE_CONFIG_CONTENT` (a JSON
`mcp.telegram-topics` local entry pointing at `bun server.ts`, merged last by
OpenCode) plus `TELEGRAM_TOPIC_ID`, `TELEGRAM_PROXY_URL`, `TG_INBOUND_MODE=pane`,
and `TELEGRAM_HARNESS=opencode` (a label for operators and scripts inspecting
the pane; `server.ts` does not read it). The stdio MCP child inherits that pane env, so
it is topic-bound and outbound-only (no second Bot API poller); a manual
`opencode` run sees no `OPENCODE_CONFIG_CONTENT` and gets no Telegram tools.
OpenCode names MCP tools `<server>_<tool>`, so the reply tool is
`telegram-topics_reply`; the kickoff and every turn envelope say so. Non-photo
attachments are downloaded eagerly by the proxy and passed as `attachment_path`,
as for Antigravity.

Instruction loading is untouched: OpenCode reads `AGENTS.md` and
`~/.claude/CLAUDE.md` natively, and the kickoff tells it to obey both while
translating Claude-harness clauses into "reply through the Telegram MCP". That
is why the FIRST turn takes two to three minutes: CLAUDE.md tells the model to
run `memo wake`, which is about 41k tokens of prefill on a local 27B. Later
turns resume from the server's prompt checkpoint and are much faster. The
activation message says so. Herdr reports the pane `unknown -> working -> idle`
across that first turn.

`/model` in a locked topic only prints status (session id, route, Herdr pane and
state, `Harness: OpenCode (locked)`); there is one model and no picker.
`/usage` answers that the local server has no quota. The callback boundary
treats `opencode` as a third harness that accepts neither `tgroute:*` nor
`agroute:*`. `POST /topic/create` accepts `harness: "opencode"`. Requests from a
localcode topic queue behind the operator's own `localcode` session on the same
Qwen server, so a busy interactive session delays Telegram replies.

## Key mechanics / gotchas (baked into the code)

- **Foreground only.** Channel injection (the `<channel>` turn from a
  notification) only works in a foreground REPL. A `--bg` agent silently drops
  it. That is why every topic gets a real foreground `claude` in tmux, not a
  background agent.
- **`--dangerously-load-development-channels` is VARIADIC** -> MUST use the
  `=form` (the space form eats the kickoff prompt as another channel entry).
  Pass it INSTEAD of `--channels` (both would double-register).
- **tmux env propagation is EXPLICIT (`new-session -e`), not inherited.** The
  launcher passes every per-topic var (`TELEGRAM_TOPIC_ID` / `TELEGRAM_PROXY_URL`
  / `TG_*` / `TG_CLAUDE_SESSION_ID` / `TG_RESUME`) to the new session with
  `tmux new-session -e VAR=...`. It must NOT rely on `new-session` inheriting the
  launcher's environment: when a tmux server is ALREADY running (e.g. the
  single-session `claude-telegram` bridge's server) a new session takes the
  SERVER's environment (seeded at server start), NOT the launcher's, so a
  freshly-set var would be empty - the pane command's `$`-refs expand to `""` and
  claude rejects the untagged `--dangerously-load-development-channels=` and dies
  instantly. Passing them via `-e` makes the pane shell expand the `$`-refs and
  makes claude + its MCP child inherit them regardless. (Requires tmux >= 3.2.)
- **Dev-channel confirm dialog auto-dismiss (still needed; window now 2 min).**
  `--dangerously-load-development-channels` can show a one-key "local
  development" confirmation dialog; the launcher's short-lived DETACHED watcher
  polls the pane for the dialog text and sends `1`+Enter. The dialog does NOT
  appear on every boot on claude >= 2.1.214 (many boots go straight to a
  channels banner) but it STILL APPEARS on some (observed on a 2.1.214
  big-transcript resume, 2026-07-18) - do not assume it is gone. The trap it
  causes when unanswered: on a BIG-transcript `--resume` the dialog renders
  AFTER the transcript loads - the original 15s watcher window lost that race
  twice (2026-07-17/18), leaving sessions REPL-alive but plugin-less with
  messages queueing undrained at the proxy. The window is now WATCHER_TRIES=480
  (2 minutes); most watchers see no dialog and just exit quietly. Manual
  unstick if it ever recurs: send `1`+Enter to the pane (tmux send-keys /
  herdr pane send-keys). NB: pane-target tmux commands
  (`capture-pane` / `send-keys`) do NOT accept the `=name` exact-match prefix that
  `has-session` does; an exact session name already resolves exactly, so the
  watcher passes the bare name.
- **Cold-start first-poll delay.** `server.ts` holds the FIRST inbound `/poll`
  for `FIRST_POLL_DELAY_MS` (default `5000`; env
  `TELEGRAM_TOPICS_FIRST_POLL_DELAY_MS`). The very first spawn-window message is
  enqueued during the ~1-2s spawn, so it is ready the instant the MCP connects -
  but a channel notification fired while the REPL is still booting (processing its
  kickoff turn) is silently dropped by the harness. Waiting lets the REPL finish
  booting and go idle before that first message is delivered, so it injects
  cleanly. Only the first poll waits; warm messages are unaffected.
- **`MCP_TIMEOUT` bump: a HUGE-transcript resume can drop the channel MCP.** The
  launcher forwards `MCP_TIMEOUT` (ms, claude's MCP-startup ceiling) into every
  pane with a generous default (`180000`). WHY (real incident 2026-07-29): a topic
  with a very large transcript (shale) resumed so slowly that the Telegram channel
  MCP's startup exceeded claude's DEFAULT timeout, so claude dropped it - the
  session ran normally (REPL up, no dialog, no visible error) but with NO channel,
  so nothing polled the proxy and every message to that topic silently queued
  undrained at the proxy. Smaller-transcript topics (hostthis, general) resumed in
  time and were fine, which is the tell: it's transcript-size-dependent, not a
  systematic resume bug. A generous ceiling is harmless for fast loaders (the MCP
  connects the moment it's ready; the ceiling only bites a slow resume). Diagnosis
  signal: the MCP is `bun server.ts` / `bun run --cwd .../telegram start` in the
  pane's process tree - a topic missing it has a dead channel (compare a working
  topic's `herdr pane process-info` against the broken one). Measured: `180000`
  recovered shale end-to-end (MCP up, queued messages delivered). If a transcript
  ever grows past that, raise the default.
- **Session continuity (one topic = one continuous conversation).** The proxy
  mints a claude session id per topic on the FIRST spawn, passed via
  `--session-id` + the kickoff. Every LATER spawn (kill / crash / proxy restart)
  RESUMES that same id via `--resume` (no kickoff), so the topic keeps its
  history. The id is persisted in `registry.json` (`claude_session_id` field) and
  survives proxy restarts. This is why all topics can safely share one spawn dir:
  bare `--continue` picks the most-recent session in a dir and cannot tell topics
  apart, so the id is tracked explicitly. NB: a session spawned BEFORE this
  tracking existed recorded no id and cannot auto-resume; recover it manually by
  writing its claude session id into `registry.json` under that topic, then
  restarting the proxy.
- **Readable, stable session names.** A topic's tmux session is
  `claude-<slug>-<thread_id>` (e.g. `claude-hostthis-34`), with the numeric thread
  id as a short, collision-proof, stable suffix; the General topic is just
  `claude-general`. `sessionNameFor(topic, label)` slugifies the topic name
  (lowercase, non-alphanumeric -> `-`, trimmed, capped 24 chars; empty ->
  `topic`), so it is always tmux-safe (no `.`/`:`/whitespace). The name is
  computed from the topic's LABEL at spawn and then RECORDED in `st.session`;
  dedup + kill use that RECORDED string (`st.session && liveTmuxSessions().has(st.session)`),
  they do NOT re-derive it - because the name now depends on the mutable label,
  re-deriving after a rename would miss the running (old-named) session and
  double-spawn. Renames are learned from `forum_topic_edited` (update `st.name` +
  `topicNames`, persist); a rename takes effect on the next RESPAWN (fresh name),
  never mid-life. An unknown name (label falls back to the numeric id) yields just
  `claude-<id>`, not `claude-<id>-<id>`. The thread-id suffix keeps names unique so
  `st.session` maps 1:1 to a topic. **Migration (old scheme `tg-<cid>-<tid>`):**
  registry-tracked live sessions are re-adopted by their old name on reconcile and
  renamed on their next respawn; for an UNtracked live old-scheme session (predates
  session-id tracking / registry lost) `ensureSession` has a migration bridge that
  ADOPTS it by `legacySessionNameFor(topic)` instead of spawning a second one under
  the new name (the launcher's has-session guard keys off the new name, so it can't
  catch an old-named orphan). Removable once no `tg-*` sessions remain.
- **Single-flight spawn.** `ensureSession` runs the launcher via `spawnSync`,
  which blocks the event loop for the whole (fast, detached) launch; grammy
  processes messages sequentially, so two rapid messages for a brand-new topic
  cannot double-spawn. Plus a `spawning` flag, plus the live-session dedup,
  plus the launcher's own `has-session` guard.
- **Nothing lost during spawn.** The inbound message is enqueued regardless; it
  waits in the topic queue until the freshly spawned MCP's first `/poll` drains
  it (~1-2s later).
- **Registry reconcile.** `~/.claude/channels/telegram-topics/registry.json`
  maps topic -> {tmux_session, thread_id, name, spawned_at, claude_session_id}.
  On boot the proxy re-adopts entries whose tmux session is still live so a proxy
  restart picks up in-flight sessions. For an entry whose session is DEAD it no
  longer forgets the topic: `loadAndReconcileRegistry` KEEPS the
  `claude_session_id` (clearing only the live-session fields) so the next inbound
  message re-spawns and `--resume`s the SAME conversation instead of starting
  fresh. `saveRegistry` persists any topic that has been spawned at least once
  (has an id), live or not.
- **General topic.** Messages in the General topic carry no `message_thread_id`
  -> topic = `"general"`, and outbound omits `message_thread_id`. Other topics:
  topic == `String(message_thread_id)`, thread id == `Number(topic)`.
- **Topic names.** Learned from `forum_topic_created` service messages (cached
  in `topicNames`) for the kickoff prompt; falls back to the thread id.
- **`--permission-mode auto`: checked auto-approve, Telegram for denials.**
  The launcher runs every topic-Claude with `--permission-mode auto`. This is NOT
  skip-all-checks: a guard model vets each command and auto-approves the SAFE ones,
  so routine work (edits, builds, tests, normal bash) runs with NO prompt. Verified
  live: a test topic-Claude ran a bash command with no prompt and the status bar
  read "auto mode on". `override-settings.json` expands the built-in policy under
  `soft_deny`, keeps the exact data/destination/transfer exfiltration rule there,
  and replaces the built-in unconditional `hard_deny` list with a deliberately
  non-matching policy marker. Consequently all real decisions remain reviewable:
  exact human intent can clear a soft denial, but no matchable hard rule can ignore
  that intent. `override-settings.json` still ENABLES the plugin for the session
  (its four-tool pre-allow is redundant under auto mode - the guard already
  approves the channel tools).
- **Action authorization: active, exact, durable, and no bypass.**
  `hooks/permission-denied.py` forwards a denied action to
  `POST /permission-denied`. The domain aggregate in
  `proxy/domain/action-authorization.ts` creates a redacted summary and security
  fingerprint; the application service deduplicates it and the JSON repository
  atomically persists it in `action-authorizations.json` with mode `0600`. Raw
  tool input is never persisted. The proxy posts **Approve once** / **Deny**
  buttons; the configured admin may also reply naturally with `yes`, `approve`,
  `do it`, `no`, or `cancel`. A bare answer resolves only the sole pending request
  in that topic; replying to a prompt binds directly to that request. Every
  decision is checked against the Telegram admin, original topic, active Claude
  UUID, and 15-minute TTL. Approval does NOT return `allow`, call a tool, or skip
  the reviewer: it enqueues one exact-action user turn into the SAME Claude
  session. Claude retries that action once and the guard re-reviews the action
  together with explicit consent. A second denial transitions to
  `reviewer-denied`; no loop, SSH workaround, or alternate execution path is
  suggested. Boot recovery re-prompts unresolved records and replays an approved
  but not-yet-delivered exact turn after a crash.
- **Legacy harness permission relay: PRESENT but DORMANT.** The separate
  permission round-trip
  (the `claude/channel/permission` capability, the MCP's `permission_request`
  handler, `POST /permission-request`, `GET /permission-poll`, `pendingPerms`,
  and the inline Allow/Deny buttons + `yes <id>` / `no <id>` text-reply handling)
  is still in the code but does not fire in normal operation: under
  `--permission-mode auto` the guard auto-approves routine commands, so the harness
  raises no permission request for them and the MCP never POSTs one. It is retained
  for re-activation: if auto mode escalates a genuinely risky command to a confirm,
  the relay could route that escalation to the Telegram topic for a human tap/reply
  instead of blocking the detached pane. What it would do when active: the MCP
  forwards a
  `permission_request` as `{topic, request_id, tool, input}` to
  `POST /permission-request`; the proxy remembers `request_id -> topic`
  (`pendingPerms`), posts an approve/deny prompt (inline buttons +
  `yes <id>`/`no <id>` form) into that topic's thread, and on the user's answer
  (`callback_query` `tgperm:allow|deny:<request_id>` or the text reply, matched
  against `pendingPerms` AND the arriving topic so a stray token relays as normal
  chat) routes `{request_id, behavior}` to the ORIGIN topic's `GET /permission-poll`,
  which fires `notifications/claude/channel/permission` to unblock the call.
  `pendingPerms` entries are pruned after 1h so the map cannot grow unbounded.
  Do not confuse this dormant harness-prompt relay with the active
  `PermissionDenied` action-authorization path above.
- **Stop hook: replies can't get stranded in the transcript.**
  `hooks/stop-reply-guard.py` runs on every Stop. If a turn was triggered by an
  inbound Telegram `<channel>` message but never called the `reply` tool, the
  answer is stranded in the transcript (the user never sees it - the classic
  "you there?" failure). The hook BLOCKS the stop
  (`{"decision":"block","reason":...}`) with a short reminder ("send it via the
  reply tool now"), so Claude re-sends through Telegram. It reminds at most ONCE
  per turn (loop guard: the `stop_hook_active` input flag AND a marker string it
  leaves in its own reason, detected in the transcript), then lets the stop
  through - no infinite loop. It parses only the last ~2MB of the transcript
  (fail-open past that) so it stays fast on huge sessions. **Wiring gotcha:** it
  is NOT shipped as a plugin `hooks/hooks.json` -
  `--dangerously-load-development-channels` loads ONLY the channel/MCP part of a
  plugin, NOT its hooks (verified: a plugin hooks.json never fired; a `--settings`
  hook did). So the hook lives in the `--settings` override. The topic-Claude
  path: `override-settings.json` references it as `python3 "$TG_HOOK"`; the proxy
  sets `TG_HOOK` to the absolute script path (`STOP_HOOK`, a `PLUGIN_ROOT`-derived
  const) in the spawn env and the launcher forwards it to the pane via
  `new-session -e TG_HOOK=...` - so that COMMITTED file needs no hardcoded path
  (hook `command`s are shell-run, so `$TG_HOOK` expands). The single-session
  bridge wires the SAME script via its own LOCAL `--settings` override
  (`~/.claude/channels/telegram/claude-settings-override.json`, absolute path -
  fine there, that file is not committed). Verified live: a channel-marked turn
  with no reply blocked the stop and made Claude call the reply tool; the loop
  guard fired exactly once. Complements (does not replace) the CLAUDE.md
  channel-discipline instruction - the instruction nudges the first reply, the
  hook backstops a miss.
- **Resilience: retry poll + PID guard + graceful shutdown.** `pollWithRetry`
  wraps `bot.start` in a backoff retry loop (ported from the single-session
  server): a rejection of `bot.start()` itself (ETIMEDOUT/ECONNRESET/DNS or a
  409 from a not-yet-drained old poller) is retried instead of silently killing
  polling forever (`bot.catch` only catches throws INSIDE update handlers). A
  PID file (`proxy.pid`) SIGTERMs any stale proxy on boot; `serveWithRetry`
  retries the `Bun.serve` bind while the old instance releases the port; SIGTERM/
  SIGINT/SIGHUP call `bot.stop()` + remove the pid file. `GET /health` reports
  `polling` + `polling_since` so a monitor can tell "up but deaf" from healthy.
- **Exfil guard on outbound files.** `handleSend` runs `assertSendable(f)` before
  shipping any file: it refuses the proxy's own state (anything under STATE_DIR
  except `inbox/`) and the token-bearing `.env` files, so a prompt-injected
  topic-Claude cannot `reply(files:['.../telegram-topics/.env'])` the bot token
  to the group. Claude can already Read+paste arbitrary OTHER paths, so this is
  not a new exfil channel - it closes only the credentials/state path.
- **One-token caveat.** Telegram allows one getUpdates consumer per token. The
  proxy and the single-session `claude-telegram` bridge cannot both poll the
  same token. Live testing means pausing whichever else polls it.

## Files

- `.claude-plugin/plugin.json`: manifest (name `telegram`).
- `.mcp.json`: starts the MCP via `bun run --cwd ${CLAUDE_PLUGIN_ROOT} ... start`.
- `server.ts` + `package.json`: the thin MCP client (dep: `@modelcontextprotocol/sdk`).
- `proxy/proxy.ts` + `proxy/package.json`: the daemon (dep: `grammy`).
- `proxy/domain/`: pure provider-route, harness-lock, Antigravity-topic,
  OpenCode-topic, inbound-delivery, and capacity types/transitions.
- `proxy/adapters/`: Claude launch profiles, bridge model catalog, Codex
  app-server client, OpenCode Go capacity client, official Antigravity catalog,
  persistent Herdr runtimes (`herdr-antigravity-runtime.ts`,
  `herdr-opencode-runtime.ts`), MCP config, JSON repositories, and
  portable-skill interop. Tests sit beside them.
- `proxy/application/antigravity-topic-service.ts`: serializes turns and keeps
  exact Antigravity conversation identity independent of Telegram and Herdr I/O.
- `proxy/application/opencode-topic-service.ts` + `opencode-ports.ts`: the same
  shape for localcode topics (session id instead of conversation id; no
  route/usage).
- `scripts/launch-topic.sh`: the one-harness launcher (invoked by the proxy;
  `TG_MUX` picks only the multiplexer). Every pane executes `claude`.
- `scripts/launch-antigravity-topic.sh`: creates a separate Herdr workspace and
  launches/resumes the persistent interactive `agy` process with topic-bound,
  outbound-only Telegram MCP environment.
- `scripts/launch-opencode-topic.sh`: creates the `oc-<slug>-<tid>` Herdr
  workspace and launches/resumes `opencode --pure` with the env-injected,
  topic-bound, outbound-only Telegram MCP.
- `scripts/start-provider-proxy.sh`: starts the loopback compatibility bridge,
  enables safe Codex response continuation, and injects the existing OpenCode
  Go credential without duplicating it.
- `scripts/start-proxy.sh`: foreground proxy starter.
- `server.ts`: the Claude Code Telegram MCP. Background subagents and proxied
  provider sessions inherit outbound tools but do not start another inbound
  poller.
- `hooks/provider-capacity-status.py`: status line plus Anthropic capacity
  adapter (`POST /capacity`).
- `hooks/stop-reply-guard.py`: the Stop hook (reply guard). Blocks a
  Telegram-triggered turn that ended without a `reply` call and reminds Claude to
  resend via the reply tool (once per turn). Wired via `override-settings.json`
  (`$TG_HOOK`, set by the proxy + forwarded by the launcher), NOT a plugin
  `hooks/hooks.json` (`--dangerously-load-development-channels` doesn't load
  those). See the Stop-hook gotcha above.
- `override-settings.json`: the BASE session settings - enables `telegram@zamua`
  AND wires the Stop hook (`hooks.Stop` -> `python3 "$TG_HOOK"`). The proxy does
  NOT hand this to the launcher directly; it generates
  one file per topic under
  `~/.claude/channels/telegram-topics/effective-settings/` from it (adding that
  route's `ultracode` value) and passes THAT as `TG_SETTINGS`. Per-topic files
  prevent concurrent spawns from racing through shared settings. (Its four-tool
  pre-allow is redundant under `--permission-mode auto`, which the launcher
  passes: the guard already approves the channel tools.)
- `.env.example`: the config contract (deny-list of known keys).
- `scripts/install-launchd.sh` + `launchd/com.telegram-topics.proxy.plist`: the
  DURABILITY path. Installs the proxy as a native launchd agent (RunAtLoad =
  auto-start on login, KeepAlive = auto-restart on crash) - NO external service
  manager, so the plugin stays self-contained. Run `scripts/install-launchd.sh`
  once. Verified: kill the proxy and launchd respawns it. Logs go to
  `~/Library/Logs/telegram-topics-proxy.log`. Uninstall = `launchctl unload` the
  plist + remove it.

## Config

Env (see `.env.example`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID`
(required); `TELEGRAM_TOPICS_SPAWN_DIR` (default `$HOME`), `TELEGRAM_PROXY_PORT`
(default `8790`), `TELEGRAM_TOPICS_MARKETPLACE` (default `plugin:telegram@zamua`),
`TELEGRAM_TOPICS_NIGHTLY_RESTART_HOUR` (0-23 local, unset = disabled),
`TELEGRAM_TOPICS_MODEL` (default the `fable` alias, see below),
`TELEGRAM_TOPICS_MULTIPLEXER` (`tmux`|`herdr`, default `tmux`; see "Multiplexer
backends" above; applies to Claude topics); `TELEGRAM_ANTIGRAVITY_BIN` (optional
path to official `agy`, defaults to the Nix per-user profile and then PATH);
`TELEGRAM_OPENCODE_BIN` (the `opencode` CLI, same fallback order; shared by the
OpenCode Go catalog and localcode topics), `TELEGRAM_OPENCODE_PROJECT_DIR`
(default `~/Dropbox/workspace/macmini/gpu/qwen-opencode`), and
`TELEGRAM_OPENCODE_MODEL` (default `qwen-local/Qwen3.8-27B`) for localcode
topics. Antigravity and localcode topics always use Herdr so they remain visible
and drop-in ready.
Loaded from the real env (wins), then plugin-dir `.env`, then
`~/.claude/channels/telegram-topics/.env`.

**Topic effort / ultracode.** Both values live on the persisted route and are
configured through `/model`; no global environment toggle is used. Ultracode
defaults off. If enabled, the domain model pins effort to xhigh because Claude
Code's Ultracode mode requires xhigh and enables standing dynamic workflows.
Models with no explicit effort variants persist `auto`, which omits `--effort`
and `CLAUDE_CODE_EFFORT_LEVEL` so the provider owns the choice. Otherwise the
launcher sets both, and the environment-level value prevents subagent/workflow
frontmatter from overriding the Telegram selection. Repeated `--settings` is
last-wins, not merged, so each spawn writes a topic-specific effective settings
file containing the route's Ultracode value. The CLI independently blocks the
`Workflow` tool while Ultracode is off, preventing stale/global settings from
starting a workflow fan-out. Legacy GPT-5.6 Sol routes that were implicitly
xhigh before this schema migrate once to medium + Ultracode off; all other
legacy routes retain their prior effort with Ultracode off.

**Topic model (the `--model` FLAG, NOT a settings key).** The proxy passes
`TELEGRAM_TOPICS_MODEL` (default the `fable` alias; `default`/`inherit`/empty =
account default; else an alias like `opus` / `sonnet` or a pinned id like
`claude-opus-5`. Prefer the ALIAS: it tracks the newest model in that family, so
a release needs no config change) to the launcher as `TG_MODEL`, which adds
`--model <id>` to the claude
command. Once a topic has a persisted `route`, that selection wins over the
environment default. **Why a flag, not a settings `model` key** (learned 2026-07-04 from a
topic coming up on the wrong model): a settings `model` is only a DEFAULT and is
IGNORED by a `--resume`d INTERACTIVE session, which restores its OWN baked-in
model - so a pre-existing topic (created on an older default) would keep that old
model forever, and baking `model` into effective-settings.json did NOT fix it
(measured: hostthis resumed to opus despite `model: claude-fable-5` in the
settings). The `--model` FLAG overrides even on resume (measured: an opus session
resumed with `--model claude-fable-5` came up fable-5). Effect is per-respawn (the
flag applies on every spawn). The launcher builds args with `set --` so a
bracketed id like `claude-fable-5[1m]` is one properly-quoted arg. The bridge
chooses its own model separately (the global `~/.claude/settings.json` `model` is
`claude-fable-5[1m]`, but the bridge session was created on opus and keeps it on
`--continue` - same resume-keeps-its-model behavior).

**Passive nightly restart.** If `TELEGRAM_TOPICS_NIGHTLY_RESTART_HOUR` is set
(0-23, LOCAL), the proxy checks once a minute and, once a day at that hour, kills
every LIVE topic session (deduped by local date). Each one re-spawns with
`--resume` on its next inbound message (fresh claude + latest launcher config,
full conversation kept). Passive by design: idle sessions are NOT kept running -
the proxy polls Telegram, the topic-Claudes don't, so they only need to be up
when in use. Mirrors the single-session bridge's nightly restart (pick up claude
updates + clear accumulated process state) without the idle cost.

The MCP client also reads `TELEGRAM_TOPICS_FIRST_POLL_DELAY_MS` (default `5000`)
for the cold-start first-poll delay above.

One-time operator setup: the `zamua` marketplace must be registered once
(`claude plugin marketplace add Zamua/claude-plugins`, or a local path) so
`--dangerously-load-development-channels=plugin:telegram@zamua` resolves. That
mutates the global `~/.claude/settings.json` (adds `extraKnownMarketplaces`).

**Forking to your own marketplace**: the plugin is deliberately free of
hardcoded paths/ids (everything flows from env; the launchd plist is templated
at install). The ONE as-shipped identity is the marketplace name
`telegram@zamua`, in exactly two places: the `TELEGRAM_TOPICS_MARKETPLACE`
default (override via env) and the `enabledPlugins` key in the committed
`override-settings.json` (edit to `telegram@<your-marketplace>`). Change both
and everything else ports as-is.

## Removed alternate harness

The short-lived delta-copy OpenCode CHANNEL PLUGIN experiment was removed: there
is no `/handoff`, no OpenCode channel plugin, and no delta-copy protocol that
mirrors a Claude topic into a second session identity. OpenCode appears in two
unrelated forms today: OpenCode Go is a provider route beneath Claude Code
through the local compatibility bridge, and `/localcode` is a harness-locked
topic on the Antigravity pattern (its own aggregate, its own pane, never a copy
of a Claude conversation). The one pilot topic of the removed experiment was
migrated by exporting its OpenCode dialogue into a one-time resume notice for
its original Claude UUID before cutover; no legacy harness fields remain in the
runtime registry contract.

## Not in v1

No session reaping/TTL, no per-topic cwd, no pairing/allowlist beyond the
group-chat-id gate. Runs under `--permission-mode auto` (guard-checked
auto-approve). Auto-mode action denials have a durable Telegram authorization
path; the older Claude Channels harness-prompt relay is coded but dormant.

The inbound + legacy permission queues are IN-MEMORY per topic: if the proxy crashes
between enqueue and the MCP's first drain, those undelivered messages/answers
are lost. `registry.json` persists session identity (topic -> tmux session +
`claude_session_id`) but NOT the queues, so a crashed-and-restarted topic
`--resume`s the SAME conversation but loses any message caught mid-flight.
Action authorizations are the exception: their lifecycle and delivery marker are
persisted in `action-authorizations.json` for crash recovery. Acceptable for v1
(the ordinary inbound drain window is ~1-2s); durable inbound queues are a future
step.
