# telegram-topics: working notes

## What it is

A drop-in replacement for the single-session `telegram` channel that fans ONE
bot token out to MANY concurrent Claude sessions, one per Telegram forum topic.
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
   │                                                    └─ ensureSession() spawns a tmux Claude
   │                                                       if none is live (single-flight)
   │  Bun.serve on 127.0.0.1:PORT
   ├── GET  /poll?topic=T             long-poll ~25s, 204 idle / 200 {content,meta}
   ├── GET  /permission-poll?topic=T  long-poll ~25s, 200 {request_id,behavior}
   ├── POST /send /react /edit /download   (keyed by topic -> message_thread_id)
   ├── POST /permission-request       {topic,request_id,tool,input} -> prompt in topic
   └── GET  /health                   {ok, topics, port, polling, polling_since}

scripts/launch-topic.sh ── spawn in the selected multiplexer (TG_MUX: tmux new-session -d
   with vars via -e, or herdr agent start with vars via /usr/bin/env; see
   "Multiplexer backends") ── session claude-<slug>-<tid> ──
   exec claude --dangerously-load-development-channels=plugin:telegram@zamua
               --settings override-settings.json --permission-mode auto
               first spawn: --session-id <id> "<kickoff>"   (mints the session)
               re-spawn:    --resume <id>                    (no kickoff, keeps history)
   + a short-lived detached watcher answers the "local development" confirm dialog

server.ts (the MCP, one per tmux session)
   ├── inbound     long-poll GET /poll -> notifications/claude/channel {content, meta}
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

- **The port** (`proxy.ts`, "multiplexer" section): `interface Multiplexer
  { kind; liveSessions(); kill(session) }` - the ONLY two operations the proxy
  core needs. `TmuxMux` shells to `tmux ls` / `tmux kill-session`; `HerdrMux`
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

## Usage-limit model failover

A topic-Claude that exhausts its model's PLAN quota (HTTP 429) would otherwise
stall forever: Claude Code's `--fallback-model` / `fallbackModel` chain is
AVAILABILITY-based (503/529) and documented to exclude rate limits, and there
is no automatic model downgrade on a plan limit - the session just fails every
turn until a human runs `/model`
(https://code.claude.com/docs/en/model-config#fallback-model-chains).

The one signal the harness gives is the **StopFailure** hook, which fires when
a turn dies on an API error with `error == "rate_limit"` for a 429. It is
notification-only (output ignored, cannot change the session's model), so the
plugin uses it purely as a tripwire:

1. `hooks/rate-limit-failover.py` (wired as `StopFailure` in
   `override-settings.json` via `$TG_FAILOVER_HOOK`; registered with NO
   matcher - it filters on the `error` field itself so it stays correct
   regardless of matcher semantics) POSTs `{topic, error, details}` to
   `POST /rate-limit`.
2. `handleRateLimit` pins `st.fallbackModel = TELEGRAM_TOPICS_MODEL_FALLBACK`
   (default the `opus` alias; empty disables the feature), kills the stalled
   session, and enqueues a SYSTEM NOTICE nudge.
3. The nudge respawns the topic through the normal `ensureSession` path with
   `--resume` + `--model <fallback>` (the `--model` FLAG overrides even on
   resume - the same property that makes per-topic model pinning work), so the
   conversation continues intact on the fallback model.

Details that matter:
- **The nudge is required.** The turn that hit the limit already CONSUMED the
  user's message, so a bare respawn would sit idle with nothing in the queue.
  The nudge tells the resumed Claude to answer the last user message.
- **Kill through `killSession`, never `mux.kill` directly, when anything may be
  enqueued afterwards.** The proxy cannot observe an MCP dying: its `/poll`
  waiter stays registered in `st.waiters` for up to ~25s, and `enqueue()`
  prefers a waiter over the queue - so a message enqueued in that window is
  handed to a dead process and LOST. This broke the first real failover
  (2026-07-19): the nudge vanished into the killed session, so the Claude that
  came back on the fallback model sat idle with nothing to do while its pane
  still showed the limit message, looking hung when the failover had actually
  worked. `killSession` kills, drains stale inbound + permission waiters
  (resolving them with null = a harmless 204 to a dead socket), and clears the
  session fields. Regression-tested by abandoning a poll, firing a failover,
  and confirming a fresh poll receives the nudge.
- **Idempotent**: a repeat report for an already-failed-over topic is a no-op,
  so a burst of hook calls cannot cause a respawn loop.
- **Persisted** in registry.json (`fallback_model`), so a proxy restart cannot
  silently drop a topic back onto an exhausted model.
- **Reverted when the quota window passes, lazily at SPAWN time**
  (`maybeRevertFallback`, called from `ensureSession`). The window is the reset
  time parsed out of the limit error when it carries one
  (`parse_reset` in the hook: accepts `|<unix>`, unix millis, or an ISO
  timestamp, and rejects anything past or >7 days out so a stray number in an
  error string cannot pin a topic for a month), else failover time +
  `TELEGRAM_TOPICS_FALLBACK_PROBE_MINUTES` (default 60). Probing early is
  cheap: if the quota is still gone the topic just fails over again.
  Deliberately lazy - a topic whose session is LIVE is skipped, because
  killing a running Claude mid-task to upgrade its model would be worse than
  the problem being solved; it picks the primary up at its next natural
  respawn. The nightly restart remains a backstop.
- **Both transitions are announced in the topic's own thread** by the PROXY
  (the topic-Claude is being killed at that moment, so it cannot speak):
  "⚠️ Hit the usage limit on X - resuming on Y. Will retry X after <time>."
  and "✅ Usage window elapsed - back on X for this topic."
- **The hook must stay python3.9-compatible**: macOS ships 3.9 as
  `/usr/bin/python3` and that is what the hook command resolves to, so
  `int | None` / `list[int]` annotations would raise at runtime - exactly when
  a rate limit hits. `from __future__ import annotations` keeps them lazy.
  (Caught in testing 2026-07-18; the same applies to stop-reply-guard.py.)
- Verified live 2026-07-18, both directions: a non-rate-limit StopFailure is
  ignored; a `rate_limit` one fails the topic over (log + registry pin +
  respawn carrying `--model claude-opus-4-8` while other topics stay on the
  primary) and posts the notice into the real topic thread; a repeat report
  no-ops; `parse_reset` unit-tested under real 3.9 across all accepted formats
  plus the past/far-future rejections; and with the window forced elapsed, the
  next spawn reverted to `--model claude-fable-5` with the ✅ notice.

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
- **`--permission-mode auto`: checked auto-approve, no prompts for routine work.**
  The launcher runs every topic-Claude with `--permission-mode auto`. This is NOT
  skip-all-checks: a guard model vets each command and auto-approves the SAFE ones,
  so routine work (edits, builds, tests, normal bash) runs with NO prompt. Verified
  live: a test topic-Claude ran a bash command with no prompt and the status bar
  read "auto mode on". The operator wanted this precisely because a detached pane
  has no one to answer prompts. Caveat: if auto mode ever escalates a genuinely
  RISKY command to an interactive confirm, a detached pane cannot answer it, so
  that call BLOCKS until someone attaches to the tmux pane. `override-settings.json`
  still ENABLES the plugin for the session (its four-tool pre-allow is redundant
  under auto mode - the guard already approves the channel tools).
- **Permission relay: PRESENT but DORMANT.** The whole permission round-trip
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
- `scripts/launch-topic.sh`: the tmux launcher (invoked by the proxy).
- `scripts/start-proxy.sh`: foreground proxy starter.
- `hooks/stop-reply-guard.py`: the Stop hook (reply guard). Blocks a
  Telegram-triggered turn that ended without a `reply` call and reminds Claude to
  resend via the reply tool (once per turn). Wired via `override-settings.json`
  (`$TG_HOOK`, set by the proxy + forwarded by the launcher), NOT a plugin
  `hooks/hooks.json` (`--dangerously-load-development-channels` doesn't load
  those). See the Stop-hook gotcha above.
- `override-settings.json`: the BASE session settings - enables `telegram@zamua`
  AND wires the Stop hook (`hooks.Stop` -> `python3 "$TG_HOOK"`). The proxy does
  NOT hand this to the launcher directly; it generates
  `~/.claude/channels/telegram-topics/effective-settings.json` from it (adding
  `ultracode`, see Config) and passes THAT as `TG_SETTINGS`. (Its four-tool
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
`TELEGRAM_TOPICS_ULTRACODE` (default ON, see below),
`TELEGRAM_TOPICS_MODEL` (default the `fable` alias, see below),
`TELEGRAM_TOPICS_MULTIPLEXER` (`tmux`|`herdr`, default `tmux`; see "Multiplexer
backends" above).
Loaded from the real env (wins), then plugin-dir `.env`, then
`~/.claude/channels/telegram-topics/.env`.

**Topic effort / ultracode.** Every topic-Claude runs at ultracode (xhigh) effort
by default. `ultracode` is a SETTINGS key (`"ultracode": true`), NOT a CLI flag
(`--effort` rejects the value), and repeated `--settings` is last-wins not merged
- so the proxy `resolveSettings()` bakes it into the ONE settings file the
launcher passes: on each start it writes
`~/.claude/channels/telegram-topics/effective-settings.json` = the committed
`override-settings.json` base + `"ultracode": <TELEGRAM_TOPICS_ULTRACODE>`
(default true; `false`/`0`/`no`/`off` -> the default medium effort), and hands
that path to the launcher as `TG_SETTINGS` (falls back to `override-settings.json`
un-generated if the read/write fails). A change takes effect on the NEXT proxy
restart; LIVE topics keep their current effort until they re-spawn (nightly 3am or
a kill). Measured via the Stop-hook input's `effort.level` field: `ultracode:true`
flips it `medium` -> `xhigh` (verified end-to-end through a real proxy-style
spawn). NB the single-session bridge sets `ultracode` in its OWN `--settings`
override, independent of this.

**Topic model (the `--model` FLAG, NOT a settings key).** The proxy passes
`TELEGRAM_TOPICS_MODEL` (default the `fable` alias; `default`/`inherit`/empty =
account default; else an alias like `opus` / `sonnet` or a pinned id like
`claude-opus-5`. Prefer the ALIAS: it tracks the newest model in that family, so
a release needs no config change) to the launcher as `TG_MODEL`, which adds
`--model <id>` to the claude
command. **Why a flag, not a settings `model` key** (learned 2026-07-04 from a
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

## Not in v1

No session reaping/TTL, no per-topic cwd, no pairing/allowlist beyond the
group-chat-id gate. Runs under `--permission-mode auto` (guard-checked
auto-approve); the permission-relay path that would route an escalated confirm to
Telegram is coded but dormant (see above).

The inbound + permission queues are IN-MEMORY per topic: if the proxy crashes
between enqueue and the MCP's first drain, those undelivered messages/answers
are lost. `registry.json` persists session identity (topic -> tmux session +
`claude_session_id`) but NOT the queues, so a crashed-and-restarted topic
`--resume`s the SAME conversation but loses any message caught mid-flight.
Acceptable for v1 (the drain window is ~1-2s); durable queues are a future step.
