# telegram-topics

One Telegram bot, many agent conversations. This plugin multiplexes a SINGLE
bot token across MANY sessions, routed by Telegram forum **topics**. Ordinary
topics keep the established foreground Claude Code harness in a detached tmux
or herdr pane and may route that same Claude session to Anthropic, Codex, or
OpenCode Go. A fresh topic can instead be explicitly and permanently locked to
Google's official Antigravity CLI harness with `/antigravity`, or to OpenCode on
a local Qwen server with `/localcode`.

It is a drop-in for the single-session telegram channel: the plugin is named
`telegram`, the MCP server is named `telegram`, and the four tools keep their
names and schemas, so the tool ids stay `mcp__plugin_telegram_telegram__*` and
the channel source stays `plugin:telegram:telegram`. Your existing habits (the
`reply` / `react` / `edit_message` / `download_attachment` tools, MarkdownV2)
transfer unchanged.

## Why a proxy

Telegram allows exactly one `getUpdates` consumer per bot token, and each
conversation must reach one foreground Claude REPL. The proxy owns the token
and selects the ingress supported by the active route: native Claude Channels
for Anthropic, or direct idle-pane prompting for a custom provider route (Claude
Code disables Channels under API billing).

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
                 │ pane: ops  │  │ pane: infra│  │ pane:general│
                 │ claude +   │  │ claude +   │  │ claude +    │
                 │ telegram   │  │ telegram   │  │ telegram    │
                 │ MCP client │  │ MCP client │  │ MCP client  │
                 └────────────┘  └────────────┘  └────────────┘

          fresh topic + /antigravity
                        │
                 ┌──────▼──────────────┐
                 │ Herdr: agy + MCP   │  one persistent interactive process
                 │ same conversation  │  live subscription model catalog
                 └─────────────────────┘

          fresh topic + /localcode
                        │
                 ┌──────▼──────────────┐
                 │ Herdr: opencode +  │  one persistent interactive process
                 │ MCP, same session  │  single local Qwen model
                 └─────────────────────┘
```

- **Proxy** (`proxy/proxy.ts`): the only `getUpdates` consumer of the token. It
  gates on the group id, computes the topic (`message_thread_id`, or `general`
  for the General topic), enqueues `{content, meta}`, and spawns the topic's
  tmux Claude if none is live (single-flight). It also serves the outbound
  tools over loopback HTTP.
- **MCP client** (`server.ts`): owns no token. On native Anthropic routes it
  long-polls `GET /poll?topic=<topic>` and injects each message as a Channel
  turn. On Codex/OpenCode routes it keeps only the outbound tools active while
  the proxy submits an equivalent `<channel>` envelope through the idle Claude
  pane. The four tools POST to the proxy (`/send`, `/react`, `/edit`,
  `/download`), each carrying its topic.
  It also retains Claude Channels' permission-relay path, but that older harness
  prompt path is dormant under auto mode. Auto-mode action denials use the hook
  path described below instead.
- **Launcher** (`scripts/launch-topic.sh`): spawns one detached multiplexer pane
  per topic running a foreground `claude` with the channel loaded, under
  `--permission-mode auto`. That is checked auto-approve, not skip-all-checks: a
  guard model vets each command and auto-approves the safe ones, so routine work
  runs with no prompt. If the guard denies an action, a hook posts a concise
  approval card in that same Telegram topic. The administrator can tap **Approve
  once** or **Deny**, or reply naturally with `yes`/`approve` or `no`/`cancel`.
  Approval sends one exact-action retry into the same Claude session; it never
  bypasses the guard or executes a tool from the proxy. It also handles session
  continuity: it mints a claude session
  id on the first spawn and `--resume`s that same id on every later spawn, so a
  topic is one continuous conversation across kills, route changes, crashes,
  and proxy restarts. Native Anthropic launches without overrides; Codex and
  OpenCode Go launch the same `claude` binary through a loopback compatibility
  bridge.
- **Antigravity application service** (`proxy/application/` +
  `proxy/adapters/antigravity-*`): owns a separate, private topic registry and
  launches one persistent interactive `agy` process in a visible Herdr
  workspace. Telegram turns are injected through Herdr; the existing MCP is
  loaded outbound-only so replies still use the proxy's single Bot API poller.
  The first launch persists the Antigravity conversation id and every relaunch
  passes `--conversation <same-id>`. A model switch restarts only the process
  with the new route, never the conversation. Its callback namespace is
  separate, and stale/forged Claude route callbacks are rejected at the
  topic-harness boundary.
- **OpenCode (localcode) application service** (`proxy/application/opencode-*` +
  `proxy/adapters/*opencode-topic*`, `herdr-opencode-runtime.ts`): the same
  shape for the OpenCode TUI on a local Qwen server. One model, no route or
  usage; the first launch persists the OpenCode session id and every relaunch
  resumes it with `-s <same-id>`. The Telegram MCP is injected through
  `OPENCODE_CONFIG_CONTENT` in the pane environment, outbound-only.

## Prerequisites

- `bun`, `claude`, a Bash shell, and either `tmux` or `herdr` on the proxy's PATH.
- Optional Antigravity topics: Google's official `agy` CLI, already authenticated
  by running `agy` once interactively, plus a running Herdr server. Antigravity
  topics always use Herdr so they remain visible and interactive. The picker is
  read dynamically from `agy models`; it is not a hard-coded model list.
- Optional localcode topics: `opencode` on PATH (or `TELEGRAM_OPENCODE_BIN`), a
  project dir whose `opencode.jsonc` defines the local provider, the local model
  server running, and a running Herdr server.
- Optional provider routing: `claude-code-proxy` on PATH. Codex must already be
  authenticated; OpenCode Go must already exist in OpenCode's local auth file.
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

(The equivalent CLI form is `claude plugin marketplace add Zamua/claude-plugins`,
or point it at a local checkout path.)

Registering the `zamua` marketplace is REQUIRED, not optional: the launcher spawns
each topic-Claude with `--dangerously-load-development-channels=plugin:telegram@zamua`,
which only resolves if that marketplace is known. Registering it mutates the global
`~/.claude/settings.json` (adds `extraKnownMarketplaces`); installing + enabling
`telegram@zamua` mutates it further. Those are the operator activation steps. This
plugin does not do them for you.

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
| `TELEGRAM_TOPICS_ADMIN_USER_ID` | for routing/approvals | secrets user id | Telegram user allowed to change routes and approve denied actions |
| `TELEGRAM_PROVIDER_PROXY_URL` | no | `http://127.0.0.1:18765` | loopback compatibility bridge |
| `TELEGRAM_PROVIDER_PROXY_BIN` | no | `claude-code-proxy` | bridge CLI used to enumerate models |
| `TELEGRAM_OPENCODE_BIN` | no | Nix per-user `opencode`, then `PATH` | CLI used to read OpenCode model metadata and to run `/localcode` topics |
| `TELEGRAM_OPENCODE_PROJECT_DIR` | no | `~/Dropbox/workspace/macmini/gpu/qwen-opencode` | project dir opened by `/localcode` topics (local provider config + `AGENTS.md`) |
| `TELEGRAM_OPENCODE_MODEL` | no | `qwen-local/Qwen3.8-27B` | the single model `/localcode` topics run |
| `TELEGRAM_PROVIDER_CAPACITY_POLL_MINUTES` | no | `5` | Codex/OpenCode Go usage refresh interval |
| `TELEGRAM_OPENCODE_AUTH_FILE` | no | OpenCode's standard auth file | source for OpenCode Go usage auth; the key is never copied into plugin state |
| `TELEGRAM_ANTIGRAVITY_BIN` | no | Nix per-user `agy`, then `PATH` | official Antigravity CLI used by harness-locked topics |
| `TELEGRAM_TOPICS_MULTIPLEXER` | no | `tmux` | `tmux` or `herdr` for Claude topics; Antigravity and localcode topics always use Herdr |
| `TELEGRAM_TOPICS_NIGHTLY_RESTART_HOUR` | no | (disabled) | 0-23 local; once a day at this hour the proxy kills live topic sessions (each `--resume`s on its next message) |
| `TELEGRAM_TOPICS_MODEL` | no | `fable` | initial model for topics without a persisted route; `/model` selections are persisted per topic |
| `TELEGRAM_TOPICS_FIRST_POLL_DELAY_MS` | no | `5000` | MCP-side: how long the first inbound poll is held so the booting REPL is idle before the first message is delivered |

## Run the proxy

```
scripts/start-proxy.sh          # foreground; use tmux/terminal to keep it up
```

or directly:

```
cd proxy && bun run start
```

For durability, run `scripts/install-launchd.sh` once. It installs the proxy as
a native launchd agent (`RunAtLoad` = auto-start on login, `KeepAlive` =
auto-restart on crash) from the template at
`launchd/com.telegram-topics.proxy.plist`, so the plugin needs no external
service manager (no pm2/systemd). Logs go to
`~/Library/Logs/telegram-topics-proxy.log`. Uninstall = `launchctl unload` the
plist in `~/Library/LaunchAgents/` and remove it.

Health check while it runs: `curl -s localhost:8790/health`.

For Codex/OpenCode Go routes, start `scripts/start-provider-proxy.sh` under your
service manager. It binds only to loopback. The script reads the existing
OpenCode Go key at process start; do not copy that key into `.env`. When no
explicit bridge binary is configured, the launcher prefers the active
home-manager profile before falling back to `PATH`. Codex response continuation
is enabled by default, so established main/subagent streams send only their new
turn through the Responses API instead of repeatedly uploading the complete
Claude transcript. The bridge safely falls back to full context when it cannot
continue a chain. The script also sets a private umask and restricts the bridge's
local metadata/error logs to the current user. Prompt traffic capture is not
enabled by this plugin.

## Use it

1. Start the proxy.
2. In your group, open (or create) a topic and send a message.
3. The proxy spawns a Claude for that topic (`claude-<slug>-<threadid>`), which
   replies back INTO that topic.
4. Different topic, different Claude. They run concurrently and independently.

For an Antigravity topic, create a **fresh** forum topic and run
`/antigravity` before sending it normal work. The command refuses to convert a
topic that already owns a Claude UUID. It immediately creates a visible
`agy-<slug>-<threadid>` Herdr workspace. You can watch it, focus it, or type
directly into the Antigravity REPL; Telegram continues using the same process.
After the lock:

- `/model` shows only models returned by the authenticated Antigravity
  subscription, then an effort picker. It never shows Anthropic, Codex, or
  OpenCode provider routes.
- `/model status` shows the Antigravity conversation id, Herdr workspace/state,
  and locked route.
- `/usage` shows only Antigravity subscription pools and exact reset times.
- The existing capacity interval also watches Antigravity pools; after an
  observed exhausted-to-available transition, each locked topic gets a reset
  notice and an Antigravity-only model button. It never switches automatically.
- `/relaunch` replaces the Herdr process and resumes the exact same conversation
  with freshly loaded MCP/configuration. Model switches do the same thing with
  the selected model and effort. If the pane is working, either change is queued
  for its next idle boundary.

The lock is enforced behind the UI as well: old or forged `tgroute:*` callbacks
cannot switch the topic to the Claude harness. Antigravity turns are queued per
topic, and model changes made during a running turn apply to the next one.

### OpenCode (localcode) topics

`/localcode` locks a **fresh** topic the same way, to the OpenCode TUI running
a local Qwen model in an `oc-<slug>-<threadid>` Herdr workspace. The pane runs
`opencode <project dir> -m <model> --pure` (`--pure` keeps external TUI plugins
such as a vim-mode plugin from eating injected prompts); the Telegram MCP is
injected through `OPENCODE_CONFIG_CONTENT` in the pane environment and is
outbound-only. OpenCode loads `AGENTS.md` and `~/.claude/CLAUDE.md` natively,
so the first reply takes a few minutes while those instructions run; later
turns are faster. After the lock:

- `/model` only prints status (session id, Herdr workspace/state, model). There
  is one model and no picker.
- `/usage` reports that the local server has no quota.
- `/relaunch` replaces the Herdr process and resumes the same OpenCode session
  (`-s <id>`); queued while a turn is working.
- Old or forged `tgroute:*` and `agroute:*` callbacks are rejected.

Requests share the local model server with any interactive `opencode` session
the operator runs, so they queue behind it.

### Antigravity configuration interop

Interop is deliberate rather than pretending the two harnesses have identical
plugin systems:

- `AGENTS.md` and `GEMINI.md` are native Antigravity project instructions.
- On a topic's first turn, the compatibility context tells Antigravity to read
  applicable project `CLAUDE.md` files (and relevant general guidance from
  `~/.claude/CLAUDE.md`) while translating or ignoring Claude-only channel,
  hook, permission-UI, and harness clauses.
- At proxy startup, portable Markdown skills from `~/.agents/skills`,
  `~/.claude/skills`, and the `skills/` folders of enabled Claude plugins are
  safely linked into Antigravity's native skill directory. Existing native
  Antigravity skills are preserved. Telegram plugins are explicitly excluded
  to protect the single `getUpdates` poller.
- A Claude plugin manifest, hook, custom agent, or channel is not automatically
  executable in Antigravity. Those need an explicit adapter. Antigravity-native
  plugins and MCP servers continue to use Antigravity's own configuration.
- The proxy safely adds one `telegram-topics` entry to Antigravity's global
  `mcp_config.json`, preserving other servers. It exposes no tools in unrelated
  Antigravity sessions because a topic must be explicitly bound by the launcher.

Antigravity topics run `agy --dangerously-skip-permissions` because the requested
contract is zero terminal hard gates, including while unattended from Telegram.
This is an unreviewed auto-approval mode, not Claude's reviewer-backed auto mode; only
use it in topics you trust with the Mac mini account's filesystem access.

Attach through the selected multiplexer when you need to inspect a pane. Normal
provider/model management stays in Telegram:

- `/model` — choose provider, model, effort, and Ultracode on/off with inline buttons.
- `/model status` — show this topic's Claude UUID, active route, and enforced
  subagent/auxiliary/effort/Workflow policy.
- `/usage` — show observed provider windows and reset times.

When a provider hits its limit, the proxy stops the stalled route and offers
the other providers. It switches only after the operator chooses. Claude resumes
the same UUID and is nudged to finish the unanswered message. When the exhausted
provider resets, Telegram offers a switch-back button; it does not switch
automatically or spend a banked reset credit. Switch-back buttons encode only
the provider and topic, then recover the exact saved route from durable state,
so they remain valid across proxy restarts and deployments.

Auto-compaction is route-aware; do not set it manually for topic sessions.
Anthropic uses Claude Code's provider-managed value, Codex compacts at 272k,
and OpenCode Go uses the selected model's installed context metadata (up to 1m,
with a 200k fallback only when metadata cannot be read). These values set the
capacity used by Claude Code's compaction calculation; Claude Code still applies
its own near-capacity trigger percentage. The OpenCode picker is
built from the full installed catalog, so newly installed models remain visible;
the bridge reports clearly if its allowlist still needs updating.

The Telegram route also owns nested execution. Ordinary subagents are pinned to
the selected main model and effort. Auxiliary/title work uses a cheaper model
from the same provider (Anthropic Haiku, Codex GPT-5.6 Luna, or OpenCode Go
GPT-5.6 Luna, with main-model fallback). Ultracode off blocks the Workflow tool
at launch, so stale Claude settings cannot start an expensive workflow fan-out;
turning it on explicitly is the only way to expose Workflow.

Provider switching does not fork the conversation. The same Claude UUID is
resumed with the selected provider/model. Only inbound transport differs:
Anthropic uses native Channels; custom-provider sessions use the multiplexer
prompt port because Claude Code rejects Channel delivery in that auth mode.

Each topic is one continuous conversation. If its session dies (you kill it, it
crashes, the proxy restarts), the next message to that topic re-spawns Claude and
resumes the same conversation with its history intact.

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
| `POST /permission-denied` | Claude `PermissionDenied` hook payload | creates or deduplicates a Telegram approval request |
| `POST /rate-limit` | `{topic, error, details, reset_at?}` | pauses the exhausted route and opens the Telegram picker |
| `POST /capacity` | Anthropic capacity windows | `{ok: true}` |
| `POST /topic/create` | `{name, harness?: "claude" | "antigravity" | "opencode"}` | creates and registers a topic after validating the selected harness |
| `GET /health` | | `{ok, topics, port, polling, polling_since}` |

`topic` is the `message_thread_id` as a string, or `"general"`. On `/send`,
long text is split into 4096-char chunks (each a message); `message_ids` lists
all of them.

The two permission endpoints (`/permission-request`, `/permission-poll`) are
DORMANT in normal operation: topic-Claudes run under `--permission-mode auto`,
whose guard auto-approves routine commands, so the harness raises no permission
request for them and the MCP never calls these. They are retained for
re-activation (route an escalated risky-command confirm to Telegram instead of
blocking the pane). When active, `POST /permission-request` posts an approve/deny
prompt into the topic and the user's answer is routed back over
`GET /permission-poll` as `{request_id, behavior}` (`behavior` is `"allow"` or
`"deny"`).

`POST /permission-denied` is the active auto-mode authorization path. It stores
only a redacted action summary, reason, fingerprint, topic, and Claude session id
in `action-authorizations.json` (mode `0600`). Pending approvals expire after 15
minutes. The raw tool input is not persisted. An approval is valid only for its
original topic and active Claude UUID and triggers a single exact-action retry;
a second reviewer denial ends the request instead of looping or suggesting a
workaround.

## Scope (v1)

No deletion / reaping / TTL of sessions, no per-topic directory config (every
topic uses `TELEGRAM_TOPICS_SPAWN_DIR`), and no pairing / allowlist beyond the
single group-chat-id gate. Runs under `--permission-mode auto` (guard-checked
auto-approve). Auto-mode denials are routed through the active Telegram
exact-action approval flow; the separate Claude Channels permission relay remains
dormant. A proxy restart re-adopts still-live tmux sessions
and, for topics whose session has died, keeps the recorded claude session id so
the next message resumes the same conversation (registry reconcile against
`tmux ls`, session id persisted in `registry.json`).

## Safety notes

- Every spawned Claude is un-sandboxed and may share directories with others.
  Its kickoff prompt says so; treat these sessions as you would any local
  agent. Start with a handful of topics.
- The proxy binds loopback only and drops every update whose chat id is not the
  configured group.
- Topic-Claudes run under `--permission-mode auto`: guard-verified auto-approve,
  not skip-all-checks. A guard model vets each command and auto-approves the safe
  ones, so routine Bash/WebFetch/etc. runs with no tap. Denials become Telegram
  approval requests instead of terminal gates. The default auto-mode policy is
  preserved as soft review policy, including data-exfiltration checks; there are
  no matchable unconditional hard-deny rules. Explicit approval is still reviewed
  by the guard on the one retry. Treat every topic as a capable auto-approving
  local agent; only start topics you would trust with largely unattended shell
  access.
- Antigravity topics deliberately run the CLI's skip-permissions mode so no
  approval prompt can become a hard gate. They do not use the Claude
  reviewer classifier or Telegram exact-action approval flow.
- The Codex/OpenCode compatibility bridge is unofficial and necessarily sees
  proxied prompts, tool payloads, and provider responses. Pin and review upgrades.
  This installation binds it only to `127.0.0.1`; local traffic capture is off;
  credentials stay in the providers' existing stores; and bridge state/logs are
  private to the local user. Unofficial-client provider/account risk still
  remains even when the local code is clean.
- Outbound file sends refuse the proxy's own state and the token-bearing `.env`,
  so a prompt-injected topic-Claude cannot ship the bot token to the group.
- A Stop hook (`hooks/stop-reply-guard.py`) keeps replies from getting stranded
  in the transcript: if a turn triggered by a Telegram message ends without
  calling the `reply` tool, it blocks the stop and reminds Claude to resend via
  Telegram (at most once per turn). It is wired through the session's `--settings`
  override, not a plugin hook - `--dangerously-load-development-channels` loads a
  plugin's channel/MCP part but not its `hooks/`.

## License

MIT.
