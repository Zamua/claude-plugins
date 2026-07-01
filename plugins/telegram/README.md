# telegram-topics

One Telegram bot, many Claudes. This plugin multiplexes a SINGLE bot token
across MANY concurrent Claude Code sessions, routed by Telegram forum
**topics**. Each topic in your group gets its own foreground Claude in its own
detached tmux session; you talk to a different Claude by switching topics.

It is a drop-in for the single-session telegram channel: the plugin is named
`telegram`, the MCP server is named `telegram`, and the four tools keep their
names and schemas, so the tool ids stay `mcp__plugin_telegram_telegram__*` and
the channel source stays `plugin:telegram:telegram`. Your existing habits (the
`reply` / `react` / `edit_message` / `download_attachment` tools, MarkdownV2)
transfer unchanged.

## Why a proxy

Telegram allows exactly one `getUpdates` consumer per bot token, and Claude's
channel injection only works for a FOREGROUND session (a `--bg` agent silently
drops the channel notifications). So the token and the poll live in ONE place,
and each conversation is a real foreground REPL:

```
                    ┌──────────────────────────────────────────────┐
   Telegram  ──────▶│  PROXY  (one token, one getUpdates poll)      │
   forum group      │   demux by message_thread_id                  │
                    │   spawn a tmux Claude per NEW topic            │
                    └───┬───────────────┬───────────────┬───────────┘
                        │ HTTP :8790    │               │
                 long-poll + POST       │               │
                        │               │               │
                 ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
                 │ tmux: ops  │  │ tmux: infra│  │ tmux:general│
                 │ claude +   │  │ claude +   │  │ claude +    │
                 │ telegram   │  │ telegram   │  │ telegram    │
                 │ MCP client │  │ MCP client │  │ MCP client  │
                 └────────────┘  └────────────┘  └────────────┘
```

- **Proxy** (`proxy/proxy.ts`): the only `getUpdates` consumer of the token. It
  gates on the group id, computes the topic (`message_thread_id`, or `general`
  for the General topic), enqueues `{content, meta}`, and spawns the topic's
  tmux Claude if none is live (single-flight). It also serves the outbound
  tools over loopback HTTP.
- **MCP client** (`server.ts`): a thin per-session channel. It owns no token
  and does no polling. Inbound, it long-polls `GET /poll?topic=<topic>` and
  injects each message as a `<channel>` turn. Outbound, the four tools POST to
  the proxy (`/send`, `/react`, `/edit`, `/download`), each carrying its topic.
  It also relays permission prompts: a tool outside the pre-allowed four raises
  a permission request, which the MCP forwards to the proxy and answers from the
  approve/deny the user taps or types back in the topic.
- **Launcher** (`scripts/launch-topic.sh`): spawns one detached tmux session
  per topic running a foreground `claude`, with the channel loaded and the four
  channel tools pre-allowed. Other tools (Bash, WebFetch, ...) are NOT
  auto-allowed - they prompt, and the prompt is relayed to Telegram for a human
  approve/deny, so topic-Claudes stay fully capable but human-gated.

## Prerequisites

- `bun`, `tmux`, `claude`, and a Bash shell on the proxy's PATH.
- A Telegram bot token (BotFather).
- A Telegram **group with Topics enabled** (group settings -> Topics -> on).
- BotFather -> `/setprivacy` -> **Disable**, so the bot receives every topic
  message (not just ones that mention it).
- Add the bot to the group. Its numeric chat id (a supergroup id like
  `-1001234567890`) is your `TELEGRAM_GROUP_CHAT_ID`.

## Install (one-time, operator)

```
/plugin marketplace add Zamua/claude-plugins
/plugin install telegram@zamua
```

Installing + enabling `telegram@zamua` mutates the global `~/.claude/settings.json`;
that is the operator activation step. This plugin does not do it for you.

> **One-token caveat.** The proxy and any other poller on the same token (for
> example the single-session `claude-telegram` bridge) cannot both run
> `getUpdates`; they will fight for the slot. Use a distinct bot token, or stop
> the other poller before starting the proxy.

## Configure

Copy `.env.example` to `.env` (in this plugin dir, or in
`~/.claude/channels/telegram-topics/`) and fill it in. The real environment
always wins over a `.env` file. Keys:

| key | required | default | meaning |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | | the one bot token |
| `TELEGRAM_GROUP_CHAT_ID` | yes | | the forum supergroup id; other chats are dropped |
| `TELEGRAM_TOPICS_SPAWN_DIR` | no | `$HOME` | cwd for every spawned topic-Claude |
| `TELEGRAM_PROXY_PORT` | no | `8790` | HTTP port for the MCP clients |
| `TELEGRAM_TOPICS_MARKETPLACE` | no | `plugin:telegram@zamua` | channel ref for the launcher |

## Run the proxy

```
scripts/start-proxy.sh          # foreground; use tmux/terminal to keep it up
```

or directly:

```
cd proxy && bun run start
```

For durability there is a LaunchAgent template at
`launchd/com.telegram-topics.proxy.plist` (fill the two placeholders, copy into
`~/Library/LaunchAgents/`, `launchctl load`). It is a template only; nothing
here installs it.

Health check while it runs: `curl -s localhost:8790/health`.

## Use it

1. Start the proxy.
2. In your group, open (or create) a topic and send a message.
3. The proxy spawns a tmux Claude for that topic (`tmux ls` shows
   `tg-<chatid>-<threadid>`), which replies back INTO that topic.
4. Different topic, different Claude. They run concurrently and independently.

Attach to any topic's session to watch it: `tmux attach -t tg-<chatid>-<threadid>`.

## Proxy <-> MCP HTTP protocol

Loopback only (`127.0.0.1:8790`).

| method + path | body | response |
| --- | --- | --- |
| `GET /poll?topic=<t>` | | `204` (nothing in ~25s) or `200 {content, meta}` (one message) |
| `GET /permission-poll?topic=<t>` | | `204` (nothing in ~25s) or `200 {request_id, behavior}` (one answer) |
| `POST /send` | `{topic, chat_id, text, reply_to?, files?, format?}` | `{message_ids: number[]}` |
| `POST /react` | `{topic, chat_id, message_id, emoji}` | `{ok: true}` |
| `POST /edit` | `{topic, chat_id, message_id, text, format?}` | `{message_id}` |
| `POST /download` | `{topic, file_id}` | `{path}` |
| `POST /permission-request` | `{topic, request_id, tool, input}` | `{ok: true}` |
| `GET /health` | | `{ok, topics, port, polling, polling_since}` |

`topic` is the `message_thread_id` as a string, or `"general"`. On `/send`,
long text is split into 4096-char chunks (each a message); `message_ids` lists
all of them. `POST /permission-request` posts an approve/deny prompt into the
topic; the user's answer is routed back over `GET /permission-poll` as
`{request_id, behavior}` (`behavior` is `"allow"` or `"deny"`).

## Scope (v1)

No deletion / reaping / TTL of sessions, no per-topic directory config (every
topic uses `TELEGRAM_TOPICS_SPAWN_DIR`), and no pairing / allowlist beyond the
single group-chat-id gate. A proxy restart re-adopts still-live tmux sessions
and forgets dead ones (registry reconcile against `tmux ls`).

## Safety notes

- Every spawned Claude is un-sandboxed and may share directories with others.
  Its kickoff prompt says so; treat these sessions as you would any local
  agent. Start with a handful of topics.
- The proxy binds loopback only and drops every update whose chat id is not the
  configured group.
- Tools outside the four channel tools are human-gated: their permission prompt
  is relayed to the topic for an approve/deny, so a topic-Claude cannot run
  Bash/WebFetch/etc. without your tap. Only members of the configured group can
  answer (the same group gate that admits inbound messages).
- Outbound file sends refuse the proxy's own state and the token-bearing `.env`,
  so a prompt-injected topic-Claude cannot ship the bot token to the group.

## License

MIT.
