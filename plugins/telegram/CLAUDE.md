# telegram-topics: working notes

Bridge binary discovery must match `scripts/start-provider-proxy.sh`: explicit
`TELEGRAM_PROVIDER_PROXY_BIN`, then `/etc/profiles/per-user/<user>/bin`, then
PATH. Do not prefer the retired standalone Home Manager profile: its stale
catalog hides models supported by the running bridge.

## What it is

A drop-in replacement for the single-session `telegram` channel that fans ONE
bot token out to MANY concurrent agent conversations, one per Telegram forum
topic. Ordinary topics are Claude Code sessions; a fresh topic can be explicitly
and permanently harness-locked to Google's official Antigravity CLI
(`/antigravity`), to OpenCode on the local Qwen server (`/localcode`), or to the
local qwen-image generator with no agent at all (`/localgen`).
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
   ├── POST /delete                   a message the calling topic sent, within 48 h
   ├── POST /permission-request       {topic,request_id,tool,input} -> prompt in topic
   └── GET  /health                   {ok, topics, port, polling, polling_since}

fresh `/antigravity` topic ── separate aggregate/repository ── persistent Herdr `agy`
   ├── live `agy models` catalog -> model -> effort Telegram picker
   ├── first interactive launch persists conversation_id + Herdr label
   ├── Telegram prompt -> Herdr agent prompt -> outbound-only Telegram MCP
   └── relaunch/model switch -> --conversation <same-id>

fresh `/localcode` topic ── separate aggregate/repository ── persistent Herdr `opencode`
   ├── single local model (qwen-local), no route, no usage
   ├── first launch persists the OpenCode session id + Herdr label
   ├── Telegram prompt -> typed bracketed paste (immediate) -> env-injected outbound-only Telegram MCP
   └── relaunch -> -s <same-session-id>

scripts/launch-topic.sh ── spawn in the selected multiplexer (TG_MUX: tmux new-session -d
   with vars via -e, or herdr agent start with vars via /usr/bin/env; see
   "Multiplexer backends") ── session claude-<slug>-<tid> ──
   exec claude --dangerously-load-development-channels=plugin:telegram@zamua
               --settings override-settings.json <provider permission flags>
               first spawn: --session-id <id> "<kickoff>"   (mints the session)
               re-spawn:    --resume <id>                    (no kickoff, keeps history)
   + a short-lived detached watcher answers the "local development" confirm dialog

server.ts (the MCP, one per multiplexer session)
   ├── inbound     Anthropic only: long-poll GET /poll -> notifications/claude/channel
   │               (first poll held FIRST_POLL_DELAY_MS so the booting REPL is idle)
   ├── outbound    reply/react/edit/download -> POST to the proxy (each carries TOPIC)
   └── permission  DORMANT under --permission-mode auto (guard-checked auto-approve
                   raises no prompt for routine commands); retained for re-activation:
                   permission_request -> POST /permission-request;
                   long-poll GET /permission-poll -> notifications/claude/channel/permission
```

## The chat port

The proxy talks to the chat through `ChatPort` (`proxy/chat/domain/chat-port.ts`),
which names no vendor: callers pass topic keys ("general" or a thread id), never a
chat id; message ids are an opaque `MessageId` that only the adapter mints (from
what it sent, or `chat.messageId(raw)` for a value a caller holds), stored as the
numbers they are today; and `ChatCapabilities` says what the transport can do
(buttons, edits, threads, reactions, forced replies, the length it splits text at,
and its markdown dialect). `telegram/telegram-chat.ts` is the Telegram adapter:
MarkdownV2, the 4096-character split, forum threads, ForceReply, the group-scoped
command menu, `t.me/c` links and file downloads stay there, and
`telegram-chat.test.ts` pins each Bot API call it makes.

Buttons are `Actions` (`proxy/chat/domain/actions.ts`): rows of a label and an
`ActionIntent`, the typed meaning of the button (a route pick, a switch-back, a
permission answer, an Antigravity pick...). Callers never build a keyboard or a
callback string: the Telegram adapter renders intents as an inline keyboard
through the callback codec (`telegram-callback.ts`, 64-byte callback data,
tokens, and the old strings it must keep decoding), and hands a pressed button
on as an `ActionPress` (the intent, its topic, the presser's id, the other
buttons' intents, and `answer` / `update` / `clearActions`). A transport without
buttons could render the same intents as numbered text. The pickers' paging and
expiry and the legacy switch-back live in `chat/domain/pickers.ts`.

All outbound traffic goes through the port: the MCP's outbound routes, every
proxy notice (`sayIn`), spawn and turn-failed notices, reminders, the square,
the `/secret` drop, `/ask`, topic creation, the command menu, the pickers, the
permission prompt, and the harness fronts' typing indicators, notices and
photos.

Inbound traffic arrives through `ChatInbound` (`proxy/chat/domain/inbound.ts`)
as `ChatEvent`s: a `ChatMessage` (topic, id, sender, time, text or caption, the
content a turn carries, a photo or attachment by reference, the message it
replies to, a topic created or renamed) or an `ActionPress`. The adapter
(`telegram/telegram-inbound.ts`) gates the chat, describes the message, decides
the sender, owns the poll loop, and hands each event on.
`proxy/chat/inbound-router.ts` routes it: verbs, the secret drop, harness
locks, the square, service messages, permission answers, downloads, voice
transcription, the turn's meta, the pickers' operator and topic gates. grammy is
imported only under `proxy/telegram/` and where `proxy.ts` builds the bot.
`ChatEvent` also types reactions, edits, and agent-session states (working,
blocked, idle, done), with the matching capabilities `inboundReactionsAndEdits`
and `sessionStates`. Telegram reports neither (the proxy does not subscribe to
`message_reaction` or `edited_message`), and the router does not act on them.
They are there so a transport built around agent sessions, an event stream per
session with action requests in it, fits the same port.

### What an adapter must guarantee

The proxy's authority model rests on the adapter, so a second transport must
hold these before any of its traffic is trusted:

- **The gate.** Only events from the one configured space reach the router;
  anything else is dropped (messages) or refused (button presses) in the adapter.
- **The sender is verified, not described.** `Sender.id` is the transport's own
  authenticated account id, and `role` is `operator` only when that id is the
  configured operator account. It never comes from message content, a display
  name, a forwarded or quoted message, or anything a member can type.
- **Operator-origin identity comes only from that `Sender`.** A turn's
  `user_id` is copied from `Sender.id` and nothing else. Turns the proxy makes
  itself (asks, reminders, relaunch and secret notices, square deliveries, resume
  notices) build their own meta with an empty or proxy user id and never carry an
  operator id, so none of them can read as the operator.
- **One event at a time.** The next event waits until the router has finished
  the last; a topic's first two messages must not both spawn its agent.
- **Message ids round-trip.** An id the adapter handed out (`MessageId`) is
  accepted back for replies, edits and deletes. They are stored as numbers today
  (`conversations.json`, `sent-messages.json`, the `/ask` response); a transport
  with string ids means migrating those formats and the `/ask` contract.

`verify.py` (the check other topics run before acting on an operator go) anchors
on the Telegram operator's numeric user id in a channel delivery the harness
recorded. A delivery marked `origin="app"` (the conductor's) counts only when the
conductor's ledger backs it with a signature from a device pinned in verify.py's
own list (see "The conductor"). Any other transport counts for nothing until it
states which of its account ids is the operator and how that id is
authenticated, and `verify.py` checks that statement.

### Not portable yet

These lean on Telegram itself, so a second adapter has to answer each one rather
than inherit it:

- **The `/secret` drop's delete-after-store.** The value is safe only because
  the bot, a group admin, deletes the operator's own message before anything
  else happens, and the guided flow opens the reply box with Telegram's
  ForceReply. A transport where the bot cannot delete a member's message, or that
  keeps copies a delete cannot reach, would leave the value in the history; there
  the drop belongs in the client itself, never relayed.
- **The square's formatting.** Conversations are recovered from their own text:
  root and reply headers (`🤖 slug · #conv`) and the `#<conv>` an operator's reply
  quotes. A transport without reply-to text or with different threading loses
  that recovery, and the square needs its own conversation store.
- **Topic naming.** Topic names, and the session names made from them, come from
  Telegram's forum service messages (created, renamed) and from the
  bot-created-topic path, since Telegram does not echo a bot's own topic creation.
- **The markdown dialect.** Agents write MarkdownV2 because the MCP's tools say
  so. The port carries it as `format: 'markdown'` and the adapter's capabilities
  name the dialect, but `server.ts` is a separate process whose tool descriptions
  say MarkdownV2 rather than read the dialect from the proxy; another transport
  needs translation or tools that name its own.
- **Button data.** Intents fit Telegram's 64-byte callback data through short
  codes and in-memory tokens that expire with the picker; a transport with no
  buttons renders intents some other way.
- **Links and the ask post.** Message links are `t.me/c/...`, and a bot cannot
  post as the operator, which is why an ask is posted as "You asked: ...".

## The conductor

`docs/conductor.md` specifies the proxy's second front end, an API for the
operator's own apps; `docs/conductor-plan.md` is the build plan, and
`docs/conductor-v1/` the contract's fixtures. Built so far (`proxy/conductor/`):
the store, and the listener with identity, enrollment, the reads and the stream.
`CONDUCTOR_LISTEN=tailnet:<port>` serves the API on this machine's tailnet address
with its tailnet certificate (`tailscale.ts`); each request is admitted by
`whois` on its peer address (`domain/identity.ts`: this machine's own node is
refused first, then any other user, then any node off `CONDUCTOR_NODES`), and
reads also need an `X-Device` enrolled from that same node. Enrollment is written
to the hash-chained ledger (`ledger.ts`) and announced in general. Each signed
message's request (method, path, client id, body hash, timestamp, signature)
goes into the ledger and its body into `signed-bodies/`, so the operator's
`verify.py` can check an app go against a device key pinned outside this
machine; the ledger's line format is pinned in `ledger.test.ts`. Writes are
signed by the device's key (`domain/write-auth.ts`: the canonical bytes, a 120 s
window, a client id whose retry with the same body gets the first answer).
`POST /v1/topics/{id}/messages` stores the operator's message, writes it to the
ledger, and `app-delivery.ts` echoes it into Telegram and queues it as an
operator turn (`origin: app`, the device, the ledger hash) through the
lifecycle's own `enqueue`, so it is not stored twice. Push (`push-service.ts`,
`apns.ts`, payloads in `domain/push.ts`) sends each new agent or proxy message
once to every device with an APNs token, over one HTTP/2 session per Apple
environment with an ES256 token renewed every 50 minutes, and drops tokens Apple
calls dead; it needs the four `CONDUCTOR_APNS_*` settings and the listener.
With the listener on and hc topics configured, `hc-watch.ts` holds one
`events.subscribe` connection straight to the topics core's socket (never the
hc CLI, so it cannot start a core) and keeps its snapshot current through
`shared/hc-events.ts`; `topic-source.ts` turns it into each hc topic's state,
title and screen (`domain/agent-state.ts`), and `topic-tracker.ts` makes each
change of state, title, name or route a `topic` event in the store.
`control.ts` serves the app's commands (route switch, usage, relaunch,
interrupt, topic create and rename, secrets through the `/secret` drop's own
store, reminders through the reminder store) through routing's `requestRoute`, the one
path the `/model` picker also takes, the lifecycle and the chat port; each is a
ledger entry before it runs. Pin and mute are the store's own (`topic_prefs`). The session tree
(`topics/domain/session-tree.ts`: general the root, every other topic a
project with its session as coordinator, workers under a coordinator, nothing
deeper) is recorded at creation in the registry's `session` field and served
as `role`, `project_id`, `parent_id`, `spawned_by` and `spawned_at`; only the
root and the operator make projects, so `/topic/create` refuses another topic.
`approvals.ts` opens an approval while an hc topic's session is blocked on a
dialog (choices parsed from its screen by `domain/approval.ts`) and expires it
when the session moves on; nothing answers one yet. Every admitted request and
the stream's open, hello and close are logged
(`conductor: ...`). Earlier history comes in through `telegram-import.ts`
(see "Importing Telegram history" in `docs/conductor.md`): seqs at or below
zero, `imported: true`, no events. With
`CONDUCTOR_LISTEN` set, `mirroredChat` wraps the
chat port each service gets, so every message sent to a topic is also kept in
SQLite (author `agent` for the MCP's `/send`, `proxy` for everything else, with
`kind` reminder or ask for those services), and `recordingOperatorTurns` wraps
the router's `enqueue` to keep each turn carrying the operator's id. A secret
drop never becomes a turn, so its value never reaches the store, and a failed
store write is logged, never thrown. Unset, nothing is wrapped.

## Multiplexer backends (tmux | herdr | hc)

The detached topic-Claudes are hosted by a terminal multiplexer, selectable via
`TELEGRAM_TOPICS_MULTIPLEXER=tmux|herdr` (default `tmux`; read at proxy boot).
The topics listed in `TELEGRAM_TOPICS_HC_TOPICS` run under herdr-core (`hc`)
instead; `topics/topic-muxes.ts` picks each topic's backend, and a topic whose
backend changed is stopped in the old one and resumed in the new one by
`ensureSession`. hc's environment, permission and restart findings are in
`docs/herdr-core.md`.
The code follows a ports-and-adapters split so neither backend leaks into the
core:

- **The port** (`proxy/topics/multiplexer.ts`): `interface MultiplexerPort
  { kind; liveSessions(); runtime(); prompt(); interrupt(); kill(); agentPid() }`.
  `agentPid` is the process holding the session's terminal (herdr's foreground
  process group, tmux's `pane_pid`, hc's foreground pid), which the broker uses
  to tell whose descendant a caller is. `runtime` and `prompt`
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
  - herdr: one WORKSPACE per topic-Claude (`workspace create --label
    <session minus claude-> --no-focus`; the workspace label is display-only),
    whose auto-created ROOT pane hosts the agent; the pane is
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
    a SECOND poller round-robining the topic's queue.
    Bg sessions are identified by `CLAUDE_CODE_SESSION_KIND=bg`; they keep the
    outbound tools but never start the inbound/permission polls.
  - hc: one terminal per topic, `tg-<thread id>`, labelled `session=` and
    `topic=`, started with `hc run --bg --no-parent --no-notify` running the
    same exported-variable script as herdr (an hc terminal also starts in the
    core's environment). `HcMux` sends one JSON-RPC request per `hc connect`;
    every hc call runs with a minimal environment, because a call that finds
    no core starts one and the core hands its environment to every terminal.
    For the same reason neither the proxy nor the launcher calls hc while the
    session's socket accepts no connection: the core's launchd agent starts it,
    with its own Full Disk Access grant. That grant is pinned to the binary, so
    the proxy probes it (at boot, after each hc launch, hourly) and posts in
    general when it is lost or back (`topics/hc-full-disk-access.ts`).
    Claude reports `done` after each turn, which hc's own `if: idle` send
    condition refuses, so `HcMux.prompt` checks the boundary itself.
  - The claude invocation (`PANE_CMD`) is byte-identical for all backends. It
    unsets a parent Claude's identity variables and sets `USER` when missing: a
    server started inside another Claude would make the topic's Claude its
    child (no transcript, so no resume), and without `USER` Claude cannot find
    its keychain login.

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
not merely a label: a label-only check re-adopts the dead pane, never respawns,
and the launcher refuses to spawn over the label, so messages queue for a session
that does not exist. The launcher CLOSES a stale labeled pane before spawning, so
no duplicate label is stranded.
`unknown` is also reported for the first ~2s of a healthy pane's
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

## Location messages

A shared location or venue arrives as text built by `proxy/telegram/location.ts`:
`(location: <lat>, <lon>, ±<m> m) <maps link>`, or `(venue: <title>, <address>, at
<lat>, <lon>) <maps link>`. A live location is relayed once, when shared, with its
duration; its later position updates arrive as `edited_message` updates, which the
proxy does not subscribe to, so a topic never gets a stream of them.

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
transcribed it correctly. Telegram caps bot downloads at
20MB (~20 min of voice).

## Secret drop (`/secret <name>`)

The operator pastes a credential into any topic as `/secret <name>` with the
value on the next line (same line works too); `/secrets` shows names, sizes
and dates; `/unsecret <name>` removes one. Three flat verbs because Telegram's
"/" menu has no sub-commands and a phone keyboard turns `--` into an em dash;
the proxy registers them in the group's command menu at boot
(`registerCommands` in `proxy/chat/inbound-router.ts`, set through the chat port and scoped to the group). The
`/secret --list` and `/secret --delete <name>` flag forms remain as aliases,
and a flag also reads with an em or en dash. The PROXY handles all of it in
`handleSecretDrop`, before every relay path including the square, and the
message itself is never enqueued: a topic-Claude's transcript persists every
inbound message in plaintext, so the value must not reach one. Parsing and the
files live in `proxy/secrets/secret.ts` (pure, tested with `bun test`).

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
topic does what an update restart and a provider-route change do, on
demand: `killSession` (which also drains the dying MCP's long-polls, so the
nudge cannot be handed to it and lost), a proxy ack in the thread, a `SYSTEM
NOTICE` enqueued with meta `relaunch=1`, then `ensureSession` respawns with
`--resume`. The notice asks for ONE line back naming the MCP servers the
session now sees, so a respawn that fails shows up as a visible silence and
the operator can read the reloaded config off the reply. The square gets a
refusal (no claude of its own). Registered in the group's "/" menu alongside
the secret verbs (`registerCommands`); any group member may run it, since it
is not destructive: the conversation resumes.

The one exception is a topic whose bound conversation is missing on disk (see
"A missing conversation is reported, never replaced" below). There `/relaunch`
is the way out: it clears `claude_session_id`, persists the registry, and the
respawn mints a new id and starts a fresh conversation with the kickoff. The
ack names the missing id and says a new conversation was started, and the
notice tells the agent it has no earlier history. Nothing is lost that was not
already gone. The decision and both messages are pure in
`proxy/topics/domain/topic-conversation.ts` (`planRelaunch`, `spawnConversation`).

## Relaunch from the root (`broker/`)

General's agent, the root of the session tree, can relaunch the topics under it
without the operator typing `/relaunch` in each: `bun proxy/broker/relaunch-cli.ts
<topic>...` prints `applied`, `queued`, `no_agent` or `refused (<why>)` per
topic and exits 1 when anything was refused. It talks to a unix socket,
`broker.sock` in the state dir (0600), which the proxy serves only with the
conductor's ledger on.

- **Who asks** is what the kernel says, never the request: the peer's pid
  (`LOCAL_PEERPID`) and its parents (`proc_pidinfo`), in `broker/peer.ts`. The
  caller speaks for the root only when the root's agent pid, as its
  multiplexer reports it at that moment, is among them, so only processes
  general's Claude started qualify. Anyone else is refused in full.
- **Which targets**: topics under the root in the session tree
  (`descendsFrom`), so never general itself; an unknown topic is refused.
- **When**: a topic whose Claude is between turns (Claude Code's own session
  status, as for update restarts, and nothing held by the proxy) is relaunched
  at once through the same `relaunch` as `/relaunch` (ack, `relaunch=1`
  notice). A busy one is `queued` and relaunched by a 5 s sweep at its turn's
  end, or dropped if its agent stops first. A topic with no running agent is
  `no_agent`: its next spawn starts fresh anyway. A harness-locked topic goes
  through its harness, which waits for its own boundary.
- **Spacing**: relaunches run one at a time, at least 3 s apart
  (`RELAUNCH_STAGGER_MS`), whether a list or the sweep asks, so the restarted
  sessions' first replies do not all reach Telegram at once and trip its
  per-group rate limit. A list of n holds the command about 3(n-1) s.
- **The ledger**: every decision is a line before anything runs, `relaunch`
  (caller, caller pid, target, outcome, and `queued: true` when a queued one
  runs) or `relaunch_refused` (caller pid, the topic whose agent it descends
  from if any, targets, reason).

## Reminders (`remind`, `list_reminders`, `cancel_reminder`)

A topic agent's own scheduler (CronCreate) lives in its session and dies with
it, so "remind me" could silently vanish on a relaunch, an update restart or a
failover. Reminders are therefore proxy state: `reminders.json` in the state
dir (`proxy/reminders/domain/reminder.ts` validates, `proxy/reminders/json-reminder-repository.ts`
persists, both tested with `bun test`). The MCP tools post to `/remind`,
`/reminders` and `/reminder/cancel`, always scoped to the caller's own topic.

`at` must carry a zone offset: the proxy's clock says nothing about where the
operator is, so a bare local time is refused rather than guessed. Every 15s,
and once at boot, the proxy fires what is due. It posts `⏰ <text>` in the
topic first, so the operator is reached even when the agent cannot start
(quota, spawn failure). Only then does it wake the agent (`ensureSession` +
`enqueue`) with a notice carrying the optional `prompt`, meta `reminder="act"`,
or meta `reminder="notice"` when there is no prompt, which the reply guard
accepts as silence. A failed post leaves the reminder for the next tick; a
reminder overdue at boot fires then and the notice says how late. Delivery is
at least once: a proxy that dies between the post and the removal posts it again
at boot. A reminder cancelled while an earlier one is posting is not posted. A reminder
can only target a topic in the directory, because waking one spawns its agent.

## Deleting a sent message (`delete_message`)

A topic's agent can delete a message it sent with `reply`, for example one that
carried a credential to the operator. Nothing else is deletable this way. The
bot is a group admin, so Telegram itself would let it delete anyone's messages,
including the operator's; an open route would hand that to any prompt-injected
topic. So `/send` records every message id it posts against its topic in
`sent-messages.json` (0600, pruned at Telegram's 48 h delete window, so a restart
does not strand a message that must go), and `POST /delete {topic, chat_id,
message_id}` deletes only an id that topic sent inside the window; any other id
is a `403` and nothing reaches Telegram. A deleted id is forgotten. Messages the
proxy posts itself (notices, the ask post) are not recorded, so no agent can
delete them. The internal API stays unauthenticated, as for every route: a local
process could claim another topic, but even then it can delete only the bot's
own recent posts, never an operator message. Code: `proxy/sent/` (the rule in
`domain/sent-messages.ts`, the file in `json-sent-messages.ts`), the route in
`proxy/http/outbound.ts`, the tool in `server.ts` beside the four drop-in tools,
which are unchanged.

## Asks from the phone (`POST /ask`)

The operator holds the iPhone Action Button (a Shortcut now, a native app with a
Live Activity next), says a question, and gets an answer as a notification. The
proxy takes the ask over HTTP, posts it in the ask topic, hands it to that
topic's Claude, and returns the agent's first reply if it comes within the wait.
Deep answers arrive later in Telegram as new replies, so the phone pings again.

**Exposure.** `/ask` has its own listener, `127.0.0.1:${TELEGRAM_ASK_PORT}`
(default 8791), which serves nothing else. It is the only port mounted on the
tailnet: `tailscale serve --bg --set-path=/ask http://127.0.0.1:8791`. Never
mount 8790: the internal API (`/send`, `/topic/create`, ...) has no auth. The
listener answers on both `/ask` and `/`, so the mount works whether or not
tailscale strips its path. Tailnet-only, never funnel.

**Auth.** `Authorization: Bearer <token>`, compared in constant time with the
token in `TELEGRAM_ASK_TOKEN_FILE` (default `~/keys/telegram-ask-token`). The
file is read on every request, so a new token applies without a restart; no
file means `503`. Rotate: regenerate `~/keys/telegram-ask-token` and re-sign the
Shortcut with `scripts/build-ask-shortcut.py` (and re-provision the app).

**Contract** (stable; the iOS app builds against it). A `multipart/form-data` POST:

| field | | meaning |
| --- | --- | --- |
| `question` | text, or `audio` | the question, at most 2000 chars; wins when both are sent |
| `audio` | file, or `question` | a recording (anything ffmpeg reads: m4a/AAC, wav, ogg...), at most 25 MB, transcribed by the proxy's whisper. Transcription times out at 120 s, so keep clips short (a minute is plenty) |
| `image` | file, optional | a screenshot (PNG, JPEG, GIF, WebP, HEIC by signature), at most 20 MB. Ignored unless `TELEGRAM_ASK_IMAGES=on` |
| `url` | text, optional | the page the question is about, `http(s)` only |
| `wait` | number, optional | seconds to wait for the first answer, 0-50, default 25 |
| `client` | text, optional | who is asking (`shortcut`, `ios-app`), 1-32 of `[A-Za-z0-9._-]`, for the log |

```
curl -sS https://<tailnet host>/ask \
  -H "Authorization: Bearer $(cat ~/keys/telegram-ask-token)" \
  -F question='what is this paper about?' -F url=https://arxiv.org/abs/2501.00001 \
  -F wait=25 -F client=ios-app
```

`200`:

```json
{"id": "16901", "topic": "3105", "message_id": 16901,
 "telegram_url": "https://t.me/c/<chat id without -100>/3105/16901",
 "question": "what is this paper about?", "answer": "It proposes ... Checking on that…", "image": "none"}
```

`answer` is the agent's first reply to the ask's post within `wait`, as plain
text, or `null` when none came (the ask still goes ahead and the reply still
lands in Telegram). For a deep question it is "Checking on that…", and the real
answer follows in Telegram. `image` is `none` (no image sent), `accepted` or
`ignored` (screenshots are off). `telegram_url` is a deep link to the ask's post,
where later answers arrive (null when the chat is not a supergroup; absent on
proxies before it was added, so clients decode it leniently). Transcription
happens before the wait starts,
so a client's timeout must cover both.

Errors are `{"error": "<message>"}`: `400` a field is missing or malformed,
`401` no or wrong token (with `WWW-Authenticate: Bearer`), `404` another path,
`405` not a POST, `413` an image or recording over its limit (a body over 50 MB
is refused by Bun itself, not as JSON), `422` the recording gave no text
(including when transcription is unavailable), `502` Telegram refused the post,
`503` asks are not configured (no token file, a malformed `TELEGRAM_ASK_TOPIC`,
or a topic that cannot take asks), `500` anything else.

**Where asks land.** `TELEGRAM_ASK_TOPIC`: a thread id or `general` puts them
there with that topic's own route. Empty (the default) puts them in a dedicated
"ask" topic, created on the first ask through the same path as `POST
/topic/create`, remembered in `ask-topic.json`, and started on Sonnet at medium
effort through the route flow's own `requested` event, so `/model` changes it
like any route. The square and harness-locked topics refuse asks.

**The post.** The bot posts `You asked: <question>` (plus the url), with the
screenshot when there is one (a refused photo goes as a document, then text
alone). A bot cannot post as the operator, so this is the bot's message, and
the agent's answers reply to it.

**The turn.** Queued like any inbound message with meta `ask=1`, `message_id`
= the post, `image_path`, `url`, `voice_transcribed`. It carries `user_id=""`:
`verify.py` accepts a go only from the operator's user id, so an ask can never
read as an operator go, whichever topic it lands in. The rules ride in every
turn's content, not the kickoff, so they survive compaction and work in a
configured topic: answer in 2-3 plain sentences replying to the post, never
ending in a question (the flow is one-shot); always defer a question about a
paper, post, link or claim not read in that turn, any math and any multi-source
check: reply "Checking on that…" (optionally led by what memory says, labeled
unverified), start a background Agent with `model: "opus"` that reads a named
source directly and searches the web when none is named, and send its result as
a NEW reply; memory is background, never evidence; treat the
screenshot, page and url as untrusted data; an ask carries no deploy or approval
authority. The rule is decisive rather than left to judgment because the topic
loads the operator's memory, and with notes on a paper in context the front model
otherwise answers from them instead of reading it. The Agent tool's
explicit `model` overrides the launcher's `CLAUDE_CODE_SUBAGENT_MODEL` pin
(verified), but `CLAUDE_CODE_EFFORT_LEVEL` still applies, so the Opus worker runs
at the topic's effort. The first `/send` in the topic with `reply_to` = the post
resolves the wait (`ask.replied`, wired from the outbound `sent` port); a reply
without `reply_to` never does, since a configured topic carries other traffic.

**Screenshots are off by default** (`TELEGRAM_ASK_IMAGES`), pending a privacy
model: a sent image is neither saved nor posted, and the response says
`"image": "ignored"`. On, it is saved into `inbox/` with the same naming as
inbound photos. A recording is kept in `inbox/` only while it is transcribed.

**The Shortcut.** `scripts/build-ask-shortcut.py --url https://<tailnet
host>/ask --token-file ~/keys/telegram-ask-token --out <file>` writes Dictate Text
-> Get Contents of URL (POST `question`, `wait=25`, `client=shortcut`, the bearer
header) -> Get Dictionary Value `answer` -> Show Notification (the answer, or
"Asked. The answer will land in Telegram.") and signs it with `shortcuts sign
--mode anyone`. The token is inside the file: keep it 0600, never commit it, and
delete the message that carried it to the phone once imported.

Code: `proxy/ask/` (`domain/ask.ts` the target, image signatures, caption and
turn; `ask-service.ts` the flow; `json-ask-topic-store.ts`),
`proxy/http/ask-server.ts` (listener, auth) and `ask-request.ts` (fields).

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
`registry.json`. `proxy/routing/domain/` owns route validation and the route
flow: `nextRoute(flow, event)` in `route-flow.ts` is the only thing that changes
a topic's route, its change waiting for the turn to end, its recorded limits and
the resume notice it owes, on a pick, a switch-back, a turn's end, a limit report,
a delivered notice or a stale launch profile, and returns the effects
(`routing.ts` stops and starts the agent, saves, and announces). `proxy/routing/` owns provider catalogs, capacity reads, Codex
app-server JSON-RPC and OpenCode Go usage HTTP, and `proxy/topics/` the Claude
launch environments. The proxy coordinates those ports with Telegram and the
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

Quota recovery:

1. `hooks/rate-limit-failover.py` reports a StopFailure `rate_limit` to
   `POST /rate-limit`.
2. Anthropic limits are model-scoped ("You've reached your Fable 5 limit"), so the
   proxy walks the chain Opus 5.5 -> Fable -> Opus automatically
   (`quotaFallbackRoute`), keeps the limited route in `exhausted_routes`, and posts
   a "switch back" button, re-offered at the reported reset time. A limit at the end of the chain marks the provider exhausted, stops
   the stalled process, and posts provider buttons in that topic. The proxy never
   consumes a reset credit. The hook sends the provider and model its pane was
   launched with; a report naming another route than the topic's came from a
   process a change already replaced and is ignored. A report naming none falls
   back to ignoring anything inside `ROUTE_DEBOUNCE_MS` (10 s) of the last change.
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
  Anthropic Haiku 5.5 (`claude-haiku-5-5`), Codex GPT-5.6 Luna, or OpenCode Go
  GPT-5.6 Luna, with a catalog-aware fallback to the selected main model. The
  launcher exports the current `ANTHROPIC_DEFAULT_HAIKU_MODEL` and the legacy
  `ANTHROPIC_SMALL_FAST_MODEL` alias for compatibility. This auxiliary choice
  does not change the main or ordinary subagent model, but Claude Code resolves
  the `haiku` alias through `ANTHROPIC_DEFAULT_HAIKU_MODEL`, so an Agent call
  with `model: "haiku"` and the Haiku route both run that id. It must be a full
  API id: Claude Code sends the variable verbatim.
- Proxied routes set `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and
  `ANTHROPIC_MODEL` only in the spawned Claude environment. Codex models use the
  bridge's `[1m]` model suffix and a
  deliberate 272k auto-compact window (the long-context pricing boundary).
  OpenCode Go reads each installed model's actual context window from
  `opencode api model.list`, clamps it to Claude Code's 100k-1m
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
  loopback, owns no Telegram state, and receives the OpenCode Go credential at
  process start: the API key in `TELEGRAM_OPENCODE_GO_KEY_FILE` (default
  `~/keys/opencode-go-key`) when present, else the access token of the OpenCode
  Console login from `opencode auth export`. That token is short-lived and
  OpenCode refreshes it, so the pm2 entry restarts the bridge daily
  (`cron_restart`) to pick up the current one; the capacity probe re-reads it
  on every poll. The credential is not copied into
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

`TELEGRAM_ANTIGRAVITY=off` swaps the runtime for `DisabledAntigravityRuntime`
and skips the boot interop sync and usage polling, so nothing runs `agy`. That
matters because an unauthenticated `agy` opens a browser sign-in on every call.

The runtime is Google's official authenticated `agy` CLI, not the unofficial
Claude provider bridge. `launch-herdr-topic.sh` creates one visible Herdr
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
Claude-route button cannot mutate an Antigravity topic (and vice versa). Every
callback string is built and parsed by `proxy/telegram/telegram-callback.ts`, whose
decoder must keep accepting buttons already posted in chats.
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
(`proxy/harness/opencode/domain/opencode-topic.ts`, `OpencodeTopicService`,
`HerdrOpencodeRuntime`, `opencode-topics.json`) and shares only the Telegram
Bot API adapter and the generic JSON topic repository with Antigravity. Same rules: admin only, a fresh
topic with no Claude UUID/live pane, never the square, no unlock or conversion
path. A topic locked to one harness refuses the other command, every Claude
spawn/queue/notice path skips a locked topic, and a square delivery aimed at
one is dropped with a log line (no Claude pane would drain that queue).

The runtime is one visible Herdr workspace per topic, `oc-<slug>-<threadid>`,
running `opencode <project dir> --standalone` (OpenCode 2.x) with cwd = the project dir
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

Delivery is immediate typed injection. A Telegram turn is typed into the pane
(`herdr pane send-text <pane> <text>` followed by `herdr pane send-keys <pane>
Enter`) the moment it arrives; there is no idle wait and no settle window before
delivery. OpenCode queues a prompt typed while a turn is running and runs it
after the current turn, so back-to-back messages are never dropped or delayed
by the proxy. The text is wrapped in bracketed paste (`ESC [200~` ... `ESC
[201~`), which delivers a multi-line envelope as ONE prompt instead of one
submission per line (verified live with a 3.2 KB message). `herdr agent prompt`
is NOT used: that command aborts a running OpenCode turn
(`MessageAbortedError`); typed text does not. Turn latency is therefore the
model's own time.

The settle window (`OPENCODE_SETTLE_MS`, 6 s of continuous idle, polled every
second, any non-idle observation restarts it, blocked throws, 31-minute
ceiling) now gates only what happens AFTER a turn: the reply backstop and any
pending relaunch. Each injection records `injectedAt` and arms one detached
settle watcher per topic; another injection while it waits moves the watcher's
target to the newest injection (it waits again after its current wait ends).
`busy(topic)` is true while a watcher is outstanding, so `/relaunch` keeps
deferring until the pane is between turns, and the typing indicator is
refreshed every 4 s until settle. Herdr reports the pane idle between OpenCode
tool calls, which is why the window is needed at all.

Reply backstop: OpenCode has no Stop hook, so a turn can end with nothing sent
(the model answers only in the terminal, or hits its 8192-token output cap
mid-reasoning with `finish: length`). `/send` records the last outbound time per
locked topic; when the pane settles with no send since the latest injection,
the service runs
`opencode session export <session id>` (cwd = project dir), and posts the last
assistant message's text content as a proxy notice prefixed `↩︎ ` (capped at 3500 chars).
No text and `finish: length` yields an output-limit notice; no export at all
yields a generic "finished without sending a reply". The backstop never fails
the turn; a failed notice goes through the error path.

`--standalone` is load-bearing. OpenCode 2.x runs a shared background server by
default, and that server never sees the pane's environment, so the injected
config and `TELEGRAM_TOPIC_ID` would be lost. A private server inherits both.
The TUI has no model flag, so the topic's model rides in the injected config.
OpenCode 2.x does not load 1.x plugins, including 1.x TUI plugins such as a
vim-mode plugin that would eat injected text.

The Telegram MCP is injected through the environment, never through a config
file: `launch-herdr-topic.sh` exports `OPENCODE_CONFIG_CONTENT` (passed in `HX_ENV_JSON`; the topic's
`model` plus an `mcp.servers.telegram-topics` local entry pointing at
`bun server.ts`, merged last by OpenCode) plus `TELEGRAM_TOPIC_ID`, `TELEGRAM_PROXY_URL`, `TG_INBOUND_MODE=pane`,
and `TELEGRAM_HARNESS=opencode` (a label for operators and scripts inspecting
the pane; `server.ts` does not read it). The stdio MCP child inherits that pane env, so
it is topic-bound and outbound-only (no second Bot API poller); a manual
`opencode` run sees no `OPENCODE_CONFIG_CONTENT` and gets no Telegram tools.
The kickoff and every turn envelope point at "the reply tool of the
telegram-topics MCP server" rather than a qualified name, so they hold however
OpenCode prefixes MCP tools. Non-photo
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

## Harness-locked localgen topics

`/localgen [name]` is the fourth harness and the only one with no agent: a
locked topic sends every text message straight to the qwen-image server
(`POST http://127.0.0.1:${LOCALGEN_PORT || 8012}/v1/images/generations`, the
OpenAI Images shape with `n: 1` and `response_format: b64_json`) and posts the
PNG back into the same thread with `sendPhoto`. Nothing sits in between: no
Claude, no pane, no queue drain, no MCP. Bounded context:
`proxy/harness/localgen/domain/localgen-topic.ts` (aggregate, option parser, request body,
caption, failure mapping), `LocalgenTopicService` (per-topic serialization),
`QwenImageClient` (fetch adapter, logs every request/response with timing),
`localgen-topics.json` (same shape as `opencode-topics.json`).

Lock rules are the localcode ones: admin only, the topic the command is posted
in must be fresh (no Claude UUID, no live pane), never the square, no unlock
path. The optional argument sets the topic record's name (default: the learned
Telegram name, then `localgen`). `POST /topic/create` accepts
`harness: "localgen"`. Every Claude spawn/queue/notice path, the square
directory, square delivery, and the callback boundary treat a localgen topic exactly like the other locked harnesses
(`harnessLocked(topic)` in proxy.ts is the shared guard). A topic created
through the proxy as a plain Claude topic and never messaged (registry entry
with no `claude_session_id`) is lockable in place by posting `/localgen` in it;
that is how an existing "localgen" topic is adopted.

Message grammar: option words `size:WxH` (default 1024x1024), `steps:N` (1..100,
default 40), `seed:N` (default random; the server range is `[0, 2^31 - 4]`),
`n:K` (1..4, K sequential requests with seeds `seed..seed+K-1`, one photo each)
and `raw` (deliver as a document so Telegram keeps the PNG bytes) are stripped
anywhere in the text; the rest is the prompt. The caption is
`seed <n> · <size> · <steps> steps · <m>m<s>s`. An `upload_photo` chat action is
sent and refreshed every 5 s while a request runs. Prompts in one topic run in
order; a prompt that arrives while one is running gets `queued (#k)`. A photo
Telegram refuses (over 10 MB or its side limits) is re-sent as a document.
Non-text messages are answered with "text prompts only".

Errors never reach the proxy's event loop: a refused connection replies
`localgen server is down` plus `TELEGRAM_LOCALGEN_START_CMD` (default: the pm2
start line from the qwen-image ops notes) so the operator can start it from the
gpu topic; a 503 whose message says warming replies `warming up, try again in a
few minutes`; any other HTTP status relays the server's `error.message`; a
request past 30 minutes (a cold prefix bucket can take 15) times out with a
message. `/model` prints status (route, `/healthz` state, harness) and says
there is nothing to pick; `/usage` says there is no quota; `/relaunch` says
there is no agent to relaunch.

## Key mechanics / gotchas (baked into the code)

- **Probed CLIs leave MCP servers behind unless their process group is killed.** The 5-minute capacity
  refresh runs `antigravity -p /usage`; that CLI loads its MCP config, which includes our channel
  `server.ts`, and exits without stopping it. Each leftover spins at ~50% CPU and they accumulate
  across refreshes. `nodeProcessRunner` therefore spawns probes `detached` and kills `-pid` on exit and on
  timeout, and `server.ts` shuts down when `process.ppid` changes from the spawner's pid. Any new
  probe that shells out to a CLI must go through that runner.
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
  launcher's environment: when a tmux server is ALREADY running (one left by any
  earlier session) a new session takes the
  SERVER's environment (seeded at server start), NOT the launcher's, so a
  freshly-set var would be empty - the pane command's `$`-refs expand to `""` and
  claude rejects the untagged `--dangerously-load-development-channels=` and dies
  instantly. Passing them via `-e` makes the pane shell expand the `$`-refs and
  makes claude + its MCP child inherit them regardless. (Requires tmux >= 3.2.)
- **Dev-channel confirm dialog auto-dismiss.**
  `--dangerously-load-development-channels` can show a one-key "local
  development" confirmation dialog; the launcher's short-lived DETACHED watcher
  polls the pane for the dialog text and sends `1`+Enter. The dialog appears on
  some boots and not others, so the watcher always runs. On a big-transcript
  `--resume` it renders only AFTER the transcript loads; left unanswered, the
  session is REPL-alive but plugin-less and messages queue undrained at the
  proxy. Hence the long window, `WATCHER_TRIES=480` (2 minutes); most watchers
  see no dialog and exit quietly. Manual unstick: send `1`+Enter to the pane (tmux send-keys /
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
  pane with a generous default (`180000`). A very large transcript can resume so
  slowly that the channel MCP's startup exceeds claude's default timeout; claude
  then drops it and the session runs normally (REPL up, no dialog, no visible
  error) with NO channel, so every message to that topic queues undrained at the
  proxy. It depends on transcript size, not on resume in general. A generous
  ceiling costs fast loaders nothing (the MCP connects the moment it is ready). Diagnosis
  signal: the MCP is `bun server.ts` / `bun run --cwd .../telegram start` in the
  pane's process tree - a topic missing it has a dead channel (compare a working
  topic's `herdr pane process-info` against the broken one). If a transcript
  outgrows `180000`, raise the default.
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
- **A missing conversation is reported, never replaced.** Before resuming, the
  proxy checks that `<id>.jsonl` exists in some `~/.claude/projects/*/` directory
  (`proxy/topics/claude-transcript.ts`). If it is gone, it posts an error in the
  topic (at most once a minute) and spawns nothing: starting a fresh session
  would silently drop the topic's history. Claude Code deletes transcripts older
  than `cleanupPeriodDays` (default 30) at startup, so `~/.claude/settings.json`
  sets it to 36500. The error ends by pointing the operator at `/relaunch`,
  which starts a fresh conversation in that topic (see the Relaunch section).
  Editing `registry.json` while the proxy runs does not work: the registry
  lives in memory and the next save overwrites the file.
- **Readable, stable session names.** A topic's tmux session is
  `claude-<slug>-<thread_id>` (e.g. `claude-hostthis-34`), with the numeric thread
  id as a short, collision-proof, stable suffix; the General topic is just
  `claude-general`. `sessionNameFor(topic, label)` slugifies the topic name
  (lowercase, non-alphanumeric -> `-`, trimmed, capped 24 chars; empty ->
  `topic`), so it is always tmux-safe (no `.`/`:`/whitespace). The name is
  computed from the topic's LABEL at spawn and then RECORDED in the topic's
  running agent; dedup + kill use that RECORDED string, they do NOT re-derive it - because the name now depends on the mutable label,
  re-deriving after a rename would miss the running (old-named) session and
  double-spawn. Renames are learned from `forum_topic_edited` (update `st.name` +
  `topicNames`, persist); a rename takes effect on the next RESPAWN (fresh name),
  never mid-life. An unknown name (label falls back to the numeric id) yields just
  `claude-<id>`, not `claude-<id>-<id>`. The thread-id suffix keeps names unique so
  a recorded session maps 1:1 to a topic. **Migration (old scheme `tg-<cid>-<tid>`):**
  registry-tracked live sessions are re-adopted by their old name on reconcile and
  renamed on their next respawn; for an UNtracked live old-scheme session (predates
  session-id tracking / registry lost) `ensureSession` has a migration bridge that
  ADOPTS it by `legacySessionNameFor(topic)` instead of spawning a second one under
  the new name (the launcher's has-session guard keys off the new name, so it can't
  catch an old-named orphan). Removable once no `tg-*` sessions remain.
- **Single-flight spawn.** `ensureSession` runs the launcher via `spawnSync`,
  which blocks the event loop for the whole (fast, detached) launch; grammy
  processes messages sequentially, so two rapid messages for a brand-new topic
  cannot double-spawn. Plus the live-session dedup, plus the launcher's own
  `has-session` guard.
- **One agent lifecycle.** A topic's agent is `stopped`, `running` (under its
  recorded session, since its start, with its launch profile) or `failed` (the
  last start failed, or its conversation is missing on disk). Only
  `nextAgent(agent, event)` in `proxy/topics/domain/agent.ts` changes it; the
  shell in `topics/lifecycle.ts` observes the multiplexer, sends the event, and
  performs the effects it returns (start, report, drain long-polls, save). A
  failed agent starts again on a message, `/relaunch` or a route change, never
  on the pane pump's timer.
- **Nothing lost during spawn.** The inbound message is enqueued regardless; it
  waits in the topic queue until the freshly spawned MCP's first `/poll` drains
  it (~1-2s later).
- **Acknowledged delivery.** `/poll` answers carry a `delivery` id, and the MCP
  names the last one it handed to Claude in `ack` on its next poll. Until then
  the message stays in flight and goes again to whoever polls next, so a
  message handed to an MCP that died before the proxy saw its socket close
  reaches the next process. A message may so arrive twice, never not at all. A
  poll without `ack` (an MCP from before this) gets the old take-and-forget
  behaviour, with anything left in flight put back first; the pane pump does
  the same when a topic moves to pane delivery (`shared/domain/inbox.ts`,
  `http/long-poll.ts`).
- **A failed launch is reported in the topic.** When the launcher fails, the
  proxy posts the cause (at most once a minute per topic) and the message stays
  queued; the next message or `/relaunch` retries. A topic is bound to a newly
  minted conversation id only after its first launch succeeds, so a failed
  first launch never reads as a missing conversation afterwards.
- **Registry reconcile.** `~/.claude/channels/telegram-topics/registry.json`
  maps topic -> {tmux_session, thread_id, name, spawned_at, claude_session_id}.
  On boot the proxy re-adopts entries whose tmux session is still live so a proxy
  restart picks up in-flight sessions. For an entry whose session is DEAD it no
  longer forgets the topic: `loadAndReconcileRegistry` KEEPS the
  `claude_session_id` (clearing only the live-session fields) so the next inbound
  message re-spawns and `--resume`s the SAME conversation instead of starting
  fresh. `saveRegistry` persists any topic that has been spawned at least once
  (has an id), live or not. A registry.json that cannot be parsed is renamed
  to `registry.json.unreadable-<ms>` and logged before the proxy starts empty
  (`proxy/topics/registry-file.ts`), since the save that follows boot would
  otherwise overwrite every `claude_session_id`; to recover, copy the ids back
  with the proxy stopped.
- **Every other state file is set aside the same way.** An unreadable
  `antigravity-topics.json`, `opencode-topics.json`, `localgen-topics.json`,
  `reminders.json`, `sent-messages.json` or `ask-topic.json` is renamed to `<file>.unreadable-<ms>` and logged, and that
  store starts empty (`proxy/shared/state-file.ts`), instead of the proxy
  exiting at boot into a launchd crash loop. If the rename fails, boot stops
  with the cause rather than risk an overwrite.
- **General topic.** Messages in the General topic carry no `message_thread_id`
  -> topic = `"general"`, and outbound omits `message_thread_id`. Other topics:
  topic == `String(message_thread_id)`, thread id == `Number(topic)`.
- **Topic names.** Learned from `forum_topic_created` service messages (cached
  in `topicNames`) for the kickoff prompt; falls back to the thread id.
- **ChatGPT permission bypass.** Codex routes use `--dangerously-skip-permissions`
  instead of auto mode, on both fresh launches and resumes. Other providers keep
  auto mode. The model picker and route confirmations explain that tools can run
  without approval prompts. Existing sessions need `/relaunch` to pick up a launcher
  change; the same conversation UUID is preserved.
- **`--permission-mode auto`: checked auto-approve, Telegram for denials.**
  Native Anthropic and OpenCode Go topics use `--permission-mode auto`. This is NOT
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
  An auto-mode denial has no Telegram path: it returns to the Claude, which
  explains it in the topic.
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
  (hook `command`s are shell-run, so `$TG_HOOK` expands). Verified live: a channel-marked turn
  with no reply blocked the stop and made Claude call the reply tool; the loop
  guard fired exactly once. Complements (does not replace) the CLAUDE.md
  channel-discipline instruction - the instruction nudges the first reply, the
  hook backstops a miss.
- **Resilience: retry poll + PID guard + graceful shutdown.** The poll loop
  (`proxy/telegram/polling.ts`) wraps `bot.start` in a backoff retry: a
  rejection of `bot.start()` itself (ETIMEDOUT/ECONNRESET/DNS or a 409 from a
  not-yet-drained old poller) is retried instead of silently killing polling
  forever (`bot.catch` only catches throws INSIDE update handlers). A PID file
  (`proxy.pid`, `proxy/shared/pid-file.ts`) SIGTERMs any stale proxy on boot;
  the HTTP server (`proxy/http/server.ts`) retries the `Bun.serve` bind while
  the old instance releases the port; SIGTERM/
  SIGINT/SIGHUP call `bot.stop()` + remove the pid file. `GET /health` reports
  `polling` + `polling_since` so a monitor can tell "up but deaf" from healthy.
- **Exfil guard on outbound files.** `handleSend` (`proxy/http/outbound.ts`) runs `assertSendable(f)` before
  shipping any file: it refuses the proxy's own state (anything under STATE_DIR
  except `inbox/`) and the token-bearing `.env` files, so a prompt-injected
  topic-Claude cannot `reply(files:['.../telegram-topics/.env'])` the bot token
  to the group. Claude can already Read+paste arbitrary OTHER paths, so this is
  not a new exfil channel - it closes only the credentials/state path.
- **One-token caveat.** Telegram allows one getUpdates consumer per token. Two
  proxies cannot poll the same token. Live testing means pausing whichever else
  polls it.

## Files

- `.claude-plugin/plugin.json`: manifest (name `telegram`).
- `.mcp.json`: starts the MCP via `bun run --cwd ${CLAUDE_PLUGIN_ROOT} ... start`.
- `server.ts` + `package.json`: the thin MCP client (dep: `@modelcontextprotocol/sdk`).
- `proxy/proxy.ts` + `proxy/package.json`: the daemon (dep: `grammy`), and
  the composition root: it builds each context below with its ports and wires
  the Telegram handlers and HTTP routes to them. `proxy/config.ts` holds every
  path and environment setting (importing it loads the `.env` files);
  `proxy/log.ts` the log and its small text helpers.
- The proxy is grouped by context; within one, `domain/` holds the pure types
  and rules, and the rest are its application services and adapters. Tests sit
  beside the code they test.
  - `proxy/topics/`: Claude topics: the agent lifecycle (`lifecycle.ts`:
    spawn, the inbound queue, pane delivery on proxied routes, kill and
    `/relaunch`), in-memory state, the multiplexer
    (`multiplexer.ts`, tmux or herdr; `hc-mux.ts`, herdr-core; `topic-muxes.ts`,
    each topic's backend), registry.json (`registry.json` load,
    reconcile and save, `registry-file.ts`), the permission relay, Claude
    launch profiles, settings, sessions and transcripts; `domain/` holds the
    agent lifecycle (`agent.ts`), resume vs. fresh start, launch-profile
    refresh and update-restart policy.
  - `proxy/routing/`: provider/model routing below the Claude harness: the
    bridge model catalog, Codex app-server and OpenCode Go capacity clients,
    the permission notice; `domain/` holds routes, the route flow and
    capacity transitions.
  - `proxy/harness/`: the harness-locked topics. `topic-harness-adapter.ts` is
    the port the proxy drives each one through, `domain/topic-harness.ts` the
    lock rule, and `json-topic-repository.ts` their shared versioned file.
    `antigravity/`, `opencode/` and `localgen/` each hold that harness's
    Telegram front end (`*-harness.ts`), application service, ports, runtime
    adapters and `domain/` aggregate.
  - `proxy/broker/`: relaunches the root's agent asks for over a local socket
    (`domain/relaunch.ts` the rule, `relaunch-broker.ts` the service,
    `broker-server.ts` the socket, `peer.ts` the kernel's view of the caller,
    `relaunch-cli.ts` the command).
  - `proxy/square/`: the agent-to-agent square and its conversation registry.
  - `proxy/reminders/`: reminders; `domain/reminder.ts` validates.
  - `proxy/chat/`: the chat port (`domain/chat-port.ts`): what the proxy
    asks of a chat transport, with no vendor in it; inbound events
    (`domain/inbound.ts`), buttons and their intents (`domain/actions.ts`),
    picker rules (`domain/pickers.ts`), and the router every inbound event
    goes through, with the "/" menu (`inbound-router.ts`).
  - `proxy/sent/`: the messages each topic's agent sent, kept so it can
    delete its own (`delete_message`) and nothing else.
  - `proxy/ask/`: asks from the phone (`POST /ask`); `domain/ask.ts` holds
    the target, the caption and the turn with its rules.
  - `proxy/secrets/`: the `/secret` drop (`secret.ts` parses and stores,
    `secret-drop.ts` runs the Telegram exchange).
  - `proxy/telegram/`: the Bot API edge: the chat port's Telegram adapter,
    outbound (`telegram-chat.ts`) and inbound (`telegram-inbound.ts`: the
    group gate, the verified sender, updates as chat events); the poll loop
    (`polling.ts`); message description, the callback codec, file download,
    voice transcription, locations.
  - `proxy/http/`: the loopback HTTP API: the server and its route table,
    the long-polls and permission relay (`server.ts`), the outbound tools
    (`outbound.ts`), routes, request parsers and responses; and the separate
    `/ask` listener (`ask-server.ts`, `ask-request.ts`).
  - `proxy/shared/`: atomic JSON writes (`json-file.ts`: a 0600 temp file
    renamed into place, used for every state file), the single-instance pid
    file, the process runner, Herdr
    pane parsing; `domain/` holds the channel envelope, turn meta flags and
    topic slugs.
  - `proxy/contracts/`: tests that run the launch scripts and hooks end to end.
  - `proxy/proxy.e2e.test.ts`: the whole proxy, booted from a copy of the
    plugin against a stand-in Bot API, multiplexer, Herdr, opencode and image
    server.
- `scripts/launch-topic.sh`: the one-harness launcher (invoked by the proxy;
  `TG_MUX` picks only the multiplexer). Every pane executes `claude`.
- `scripts/launch-herdr-topic.sh`: shared by Antigravity and OpenCode topics
  (`HX_HARNESS`). Closes a restored pane whose agent is gone, creates the
  topic's Herdr workspace (`agy-<slug>-<tid>` / `oc-<slug>-<tid>`), and starts
  the agent (`HX_BIN` + `HX_ARGS_JSON`) with the topic-bound, outbound-only
  Telegram MCP environment plus any `HX_ENV_JSON` exports.
- `scripts/start-provider-proxy.sh`: starts the loopback compatibility bridge,
  enables safe Codex response continuation, and injects the existing OpenCode
  Go credential without duplicating it.
- `scripts/start-proxy.sh`: foreground proxy starter.
- `scripts/build-ask-shortcut.py`: builds and signs the iOS Shortcut that
  posts a dictated question to `/ask` (see "Asks from the phone").
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
  those). See the Stop-hook gotcha above. The meta flags it accepts as
  "no reply needed" come from `proxy/shared/domain/turn-meta.ts`, and
  `proxy/contracts/hook-contract.test.ts` runs the hook against turns rendered
  with them.
- `proxy/http/routes.ts`: the proxy's HTTP paths, used by the proxy,
  `server.ts`, and checked against the Python hooks' calls.
- `override-settings.json`: the BASE session settings - enables `telegram@zamua`
  AND wires the Stop hook (`hooks.Stop` -> `python3 "$TG_HOOK"`). The proxy does
  NOT hand this to the launcher directly; it generates
  one file per topic under
  `~/.claude/channels/telegram-topics/effective-settings/` from it (adding that
  route's `ultracode` value) and passes THAT as `TG_SETTINGS`. Per-topic files
  prevent concurrent spawns from racing through shared settings. (Its four-tool
  pre-allow is redundant under `--permission-mode auto`, which the launcher
  passes for non-Codex providers: the guard already approves the channel tools.)
- `.env.example`: the config contract (deny-list of known keys).
- `scripts/install-launchd.sh` + `launchd/com.telegram-topics.proxy.plist`: the
  DURABILITY path. Installs the proxy as a native launchd agent (RunAtLoad =
  auto-start on login, KeepAlive = auto-restart on crash) - NO external service
  manager, so the plugin stays self-contained. Run `scripts/install-launchd.sh`
  once. Restart it with `launchctl kickstart -k gui/$(id -u)/com.telegram-topics.proxy`:
  a plain `kill` makes the proxy shut down cleanly (exit 0), and launchd has then
  been seen to leave it down for minutes instead of respawning it. Logs go to
  `~/Library/Logs/telegram-topics-proxy.log`. Uninstall = `launchctl unload` the
  plist + remove it.

## Config

Env (see `.env.example`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID`
(required); `TELEGRAM_TOPICS_SPAWN_DIR` (default `$HOME`), `TELEGRAM_PROXY_PORT`
(default `8790`), `TELEGRAM_TOPICS_MARKETPLACE` (default `plugin:telegram@zamua`),
`TELEGRAM_TOPICS_UPDATE_RESTART` (`on`|`off`, default `on`),
`TELEGRAM_TOPICS_MODEL` (default the pinned `claude-opus-5-5`, see below),
`TELEGRAM_TOPICS_MULTIPLEXER` (`tmux`|`herdr`, default `tmux`; see "Multiplexer
backends" above; applies to Claude topics); `TELEGRAM_TOPICS_HC_TOPICS`,
`TELEGRAM_HC_BIN` and `TELEGRAM_HC_SESSION` (the topics run under herdr-core, its
binary, and the hc session, default `topics`, whose core its own launchd agent
starts); `TELEGRAM_ANTIGRAVITY_BIN` (optional
path to official `agy`, defaults to the Nix per-user profile and then PATH);
`TELEGRAM_OPENCODE_BIN` (the `opencode` 2.x CLI, default
`/opt/homebrew/bin/opencode` then PATH; the OpenCode Go catalog reads
`opencode api model.list` and localcode topics run it), `TELEGRAM_OPENCODE_PROJECT_DIR`
(default `~/Dropbox/workspace/macmini/gpu/qwen-opencode`), and
`TELEGRAM_OPENCODE_MODEL` (default `qwen-local/Qwen3.8-27B`) for localcode
topics; `LOCALGEN_PORT` (default `8012`, the qwen-image server on loopback) and
`TELEGRAM_LOCALGEN_START_CMD` (the start line shown when that server is down)
for localgen topics; `TELEGRAM_ASK_PORT`, `TELEGRAM_ASK_TOKEN_FILE`,
`TELEGRAM_ASK_TOPIC` and `TELEGRAM_ASK_IMAGES` for asks (see "Asks from the
phone"). Antigravity and localcode topics always use Herdr so they
remain visible and drop-in ready.
Loaded from the real env (wins), then plugin-dir `.env`, then
`~/.claude/channels/telegram-topics/.env`.

**Topic effort / ultracode.** Both values live on the persisted route and are
configured through `/model`; no global environment toggle is used. A new
topic's route is `DEFAULT_ROUTE`: `claude-opus-5-5` at xhigh. Each picker model
carries its own default effort in `provider-catalog.ts` (`fable` medium,
OpenCode Go `auto`). Ultracode defaults off. If enabled, the domain model pins
effort to xhigh because Claude
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
`TELEGRAM_TOPICS_MODEL` (default the pinned `claude-opus-5-5`; `default`/`inherit`/empty =
account default; else an alias like `opus` / `sonnet` or a pinned id. The
default is pinned rather than an alias so a release never changes it
silently) to the launcher as `TG_MODEL`, which adds
`--model <id>` to the claude
command. Once a topic has a persisted `route`, that selection wins over the
environment default. **Why a flag, not a settings `model` key:** a settings
`model` is only a default; a `--resume`d interactive session ignores it (also
in effective-settings.json) and restores its own model, so an existing topic
would keep its old model forever. The `--model` flag overrides even on resume
and applies on every spawn. The launcher builds args with `set --` so a
bracketed id like `claude-opus-5-5[1m]` is one properly-quoted arg.

**Update restarts.** Claude Code updates itself, but a running session keeps
the binary it started with. Once a minute the proxy compares each live topic's
version (Claude Code's own `~/.claude/sessions/<pid>.json`, matched on the
topic's `claude_session_id`) with the version `~/.local/bin/claude` resolves to.
An older session that is idle is stopped and `--resume`s on its next message. One
that is busy (mid-turn), `shell` (idle with background tasks running), or
`waiting` (on the operator), or for which the proxy still holds a queued message,
in-flight pane turn, or permission prompt, is left alone until it goes idle; it
is then restarted and resumed at once, and the topic gets a one-line notice.
A session that has been `shell` for over an hour (`LINGERING_SHELL_MS`, measured
from the record's `statusUpdatedAt`) counts as idle: that is a leftover dev
server, not work in progress, and stopping the session stops it too.
Each topic is restarted at most once per installed version, so a launcher that
resolves a different `claude` cannot loop. The waiting state is in memory: after
a proxy restart a topic still waiting is treated as idle-stale and only stopped.
Policy is pure in `proxy/topics/domain/claude-update.ts`; the session records and the
installed version are read by `proxy/topics/claude-sessions.ts`; the sweep is
`proxy/topics/update-restarts.ts`.

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

## OpenCode: two unrelated forms

OpenCode Go is a provider route beneath Claude Code through the local
compatibility bridge; `/localcode` is a harness-locked topic on the Antigravity
pattern (its own aggregate, its own pane, never a copy of a Claude
conversation). There is no `/handoff` and no OpenCode channel plugin: nothing
mirrors a Claude topic into a second session identity.

## Not in v1

No session reaping/TTL, no per-topic cwd, no pairing/allowlist beyond the
group-chat-id gate. ChatGPT routes bypass permission checks; other Claude Code
routes use `--permission-mode auto` (guard-checked auto-approve). The Claude
Channels harness-prompt relay is coded but dormant.

The inbound + legacy permission queues are IN-MEMORY per topic: if the proxy crashes
between enqueue and the MCP's first drain, those undelivered messages/answers
are lost. `registry.json` persists session identity (topic -> tmux session +
`claude_session_id`) but NOT the queues, so a crashed-and-restarted topic
`--resume`s the SAME conversation but loses any message caught mid-flight.
Acceptable for v1
(the ordinary inbound drain window is ~1-2s); durable inbound queues are a future
step.
