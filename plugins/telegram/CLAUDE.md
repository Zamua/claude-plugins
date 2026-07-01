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

scripts/launch-topic.sh ── tmux new-session -d -s tg-<cid>-<tid> ──
   exec claude --dangerously-load-development-channels=plugin:telegram@zamua
               --settings override-settings.json --permission-mode acceptEdits "<kickoff>"

server.ts (the MCP, one per tmux session)
   ├── inbound     long-poll GET /poll -> notifications/claude/channel {content, meta}
   ├── outbound    reply/react/edit/download -> POST to the proxy (each carries TOPIC)
   └── permission  permission_request (from harness) -> POST /permission-request;
                   long-poll GET /permission-poll -> notifications/claude/channel/permission
```

## Key mechanics / gotchas (baked into the code)

- **Foreground only.** Channel injection (the `<channel>` turn from a
  notification) only works in a foreground REPL. A `--bg` agent silently drops
  it. That is why every topic gets a real foreground `claude` in tmux, not a
  background agent.
- **`--dangerously-load-development-channels` is VARIADIC** -> MUST use the
  `=form` (the space form eats the kickoff prompt as another channel entry).
  Pass it INSTEAD of `--channels` (both would double-register).
- **tmux session-env capture.** `tmux new-session` snapshots the launcher
  process's environment as the new session's environment. So exporting
  `TELEGRAM_TOPIC_ID` / `TELEGRAM_PROXY_URL` (and `TG_*`) before `new-session`
  makes the pane shell expand the `$`-refs and makes claude + its MCP child
  inherit them. Verified against tmux 3.6a.
- **Exact session match.** Dedup uses `tmux has-session -t "=$name"` and
  `liveTmuxSessions().has(name)` (from `tmux ls -F`) so `tg-<cid>-4` never
  matches `tg-<cid>-45`.
- **Single-flight spawn.** `ensureSession` runs the launcher via `spawnSync`,
  which blocks the event loop for the whole (fast, detached) launch; grammy
  processes messages sequentially, so two rapid messages for a brand-new topic
  cannot double-spawn. Plus a `spawning` flag, plus the live-session dedup,
  plus the launcher's own `has-session` guard.
- **Nothing lost during spawn.** The inbound message is enqueued regardless; it
  waits in the topic queue until the freshly spawned MCP's first `/poll` drains
  it (~1-2s later).
- **Registry reconcile.** `~/.claude/channels/telegram-topics/registry.json`
  maps topic -> {tmux_session, thread_id, name, spawned_at}. On boot the proxy
  re-adopts entries whose tmux session is still live and forgets the rest, so a
  proxy restart picks up in-flight sessions.
- **General topic.** Messages in the General topic carry no `message_thread_id`
  -> topic = `"general"`, and outbound omits `message_thread_id`. Other topics:
  topic == `String(message_thread_id)`, thread id == `Number(topic)`.
- **Topic names.** Learned from `forum_topic_created` service messages (cached
  in `topicNames`) for the kickoff prompt; falls back to the thread id.
- **Pre-allow the 4 tools; relay everything else.** A detached session cannot
  answer a permission prompt locally, so `override-settings.json` pre-allows the
  four channel MCP tools (asking to approve the reply tool for every reply would
  be absurd) rather than using `bypassPermissions` (which the classifier blocks).
  Launch runs `--permission-mode acceptEdits`. Any OTHER tool (Bash, WebFetch,
  ...) is NOT auto-allowed: its permission prompt is relayed to the Telegram
  topic via the permission round-trip below, so topic-Claudes stay fully capable
  but every non-pre-allowed action is gated by a human tap/reply.
- **Permission relay (proxy <-> MCP round-trip).** The MCP declares
  `experimental["claude/channel/permission"] = {}` and handles the harness's
  `notifications/claude/channel/permission_request`. On a request it POSTs
  `{topic, request_id, tool, input}` to the proxy's `POST /permission-request`.
  The proxy remembers `request_id -> topic` (`pendingPerms`) and posts an
  approve/deny prompt (inline Allow/Deny buttons + a `yes <id>` / `no <id>` text
  form) INTO that topic's Telegram thread. The user answers by tapping a button
  (`callback_query` `tgperm:allow|deny:<request_id>`) or replying `yes <id>` /
  `no <id>` in the thread; the proxy intercepts that reply (matched against
  `pendingPerms` AND the arriving topic, so a stray token relays as normal chat)
  and routes `{request_id, behavior}` to the ORIGIN topic's separate
  `GET /permission-poll` long-poll. The MCP's permission loop then fires
  `notifications/claude/channel/permission` with the matching `request_id`,
  unblocking the pending tool call. An answer is delivered to `pendingPerms[id].topic`
  (the session that asked), so it cannot be mis-routed. A never-answered request
  stays pending (the session waits, as it would for any un-answered prompt);
  `pendingPerms` entries are pruned after 1h so the map cannot grow unbounded (a
  pruned entry just means a very late reply won't route).
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
- `override-settings.json`: enables `telegram@zamua` + pre-allows the 4 tools.
- `.env.example`: the config contract (deny-list of known keys).
- `launchd/com.telegram-topics.proxy.plist`: durability template (NOT installed).

## Config

Env (see `.env.example`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID`
(required); `TELEGRAM_TOPICS_SPAWN_DIR` (default `$HOME`), `TELEGRAM_PROXY_PORT`
(default `8790`), `TELEGRAM_TOPICS_MARKETPLACE` (default `plugin:telegram@zamua`).
Loaded from the real env (wins), then plugin-dir `.env`, then
`~/.claude/channels/telegram-topics/.env`.

## Not in v1

No session reaping/TTL, no per-topic cwd, no pairing/allowlist beyond the
group-chat-id gate.

The inbound + permission queues are IN-MEMORY per topic: if the proxy crashes
between enqueue and the MCP's first drain, those undelivered messages/answers
are lost. `registry.json` persists session identity (topic -> tmux session) but
NOT the queues. Acceptable for v1 (the drain window is ~1-2s); durable queues
are a future step.
