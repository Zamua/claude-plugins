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
  - herdr: `herdr agent start <name> --cwd ... -- /usr/bin/env VAR=... bash -c
    "$PANE_CMD"`. The env prefix is REQUIRED (a herdr pane inherits the herdr
    SERVER's environment - often a minimal launchd one - never the launcher's),
    and PATH is forwarded the same way so `claude` resolves. The dialog watcher
    polls the socket API (`pane.read`, newline-delimited JSON over
    `~/.config/herdr/herdr.sock`; NB `source` is required and must be
    `visible`) and answers with `herdr pane send-keys <pane_id> 1 Enter`.
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
- **Dev-channel confirm dialog auto-dismiss.**
  `--dangerously-load-development-channels` shows a one-key "local development"
  confirmation dialog in an interactive session (third-party channel plugins are
  not first-party-approved; `allowedChannelPlugins` is honored only in MANAGED
  settings, which we avoid). A detached pane has no one to answer it, so the
  launcher runs a short-lived DETACHED watcher that polls the pane for the dialog
  text and sends `1`+Enter, then exits. NB: pane-target tmux commands
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
`TELEGRAM_TOPICS_MODEL` (default `claude-fable-5`, see below),
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
`TELEGRAM_TOPICS_MODEL` (default `claude-fable-5`; `default`/`inherit`/empty =
account default; else a model id like `claude-opus-4-8` / `claude-sonnet-5` or an
alias) to the launcher as `TG_MODEL`, which adds `--model <id>` to the claude
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
