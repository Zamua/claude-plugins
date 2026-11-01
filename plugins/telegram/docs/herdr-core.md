# herdr-core (`hc`) as a topic multiplexer

herdr-core is a terminal multiplexer whose core keeps every terminal's program,
screen and agent status, and answers JSON-RPC over a socket. The proxy can host
chosen topics' Claudes in it, beside the default tmux or herdr backend.

## How the proxy uses it

- **Per topic.** `TELEGRAM_TOPICS_HC_TOPICS` (comma list of thread ids, or
  `general`) puts those topics on hc; every other topic stays on
  `TELEGRAM_TOPICS_MULTIPLEXER`. `TELEGRAM_HC_BIN` names the binary (default
  `~/.local/bin/hc`).
- **Naming.** A topic's terminal is `tg-<thread id>`, labelled
  `session=<session name>` and `topic=<thread id>`. The session label is what
  the proxy and the launcher's dedup look a topic up by.
- **Calls.** The proxy sends one request per `hc connect` (`terminal.list`,
  `read`, `send`, `kill`, `rm`); the launcher uses the CLI (`ls`, `rm`, `run
  --bg --no-parent --no-notify`, `read`, `keys`).
- **Status.** Claude reports its own status to hc. It reports `done` after
  every turn and `idle` only at boot or after a resume, so both count as a turn
  boundary, and so does `error` (a turn that ended on an API error). hc's own
  send condition `if: idle` refuses `done`, so the adapter checks the boundary
  itself. `blocked` is a dialog. A terminal that has not reported yet is
  starting, unless only a shell is left in it. A finished terminal is missing.
- **Moving a topic.** Add it to the list and restart the proxy. Its next
  message stops it where it ran and resumes the same conversation under hc.
  Removing it from the list moves it back the same way.

## The core's environment

The core keeps the environment it was started in, and every terminal inherits
it. Whatever starts the core therefore decides what every topic's Claude sees.
`hc run` has no option to start a terminal with a clean environment.

- **Started by the proxy.** A call that finds no core starts one. The proxy's
  environment holds the bot token, so every hc call (proxy and launcher) runs
  with only `HOME`, `PATH`, `USER`, `LANG`, `TMPDIR`, `HC_SESSION`,
  `HC_SOCKET`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME`.
- **Started or restarted inside another Claude.** `hc server restart` re-execs
  the core in the environment of whoever runs it. Run from an agent's shell,
  every later terminal inherits that agent's identity (`CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`, its messaging socket and token) and its topic
  variables. A Claude that sees a parent's identity runs as its child and saves
  no transcript, so it cannot be resumed. The pane command unsets those
  variables before starting Claude, for every backend.
- **Started without `USER`.** Claude finds its login in the keychain by `USER`.
  Under a core started without it, every Claude is logged out (`claude auth
  status` reports `loggedIn: false`). The pane command sets `USER` from `id -un`
  when it is missing.

Restart the core through its launchd job, never with `hc server restart` from
an agent's shell.

## macOS privacy permissions (TCC)

The core is the responsible process for everything in its terminals, and it
keeps the responsibility of the process tree that first started it. Probed
with a protected-folder listing inside an hc terminal:

| How the core started | Protected read |
| --- | --- |
| From a shell under a process that has Full Disk Access | allowed |
| As its own launchd job (`herdr-core serve`), no grant | denied |
| Auto-started by the first hc call of a launchd bash job | denied |

So the outcome depends on which process happens to make the first call.
Run the core as a dedicated launchd agent whose program is the `herdr-core`
binary itself (`ProgramArguments: [<path>/herdr-core, serve]`, `RunAtLoad`,
`KeepAlive`, a clean `EnvironmentVariables` with `HOME`, `USER`, `PATH`,
`LANG` and a dedicated `HC_SESSION`), and grant Full Disk Access to that
binary. The release binary is ad-hoc signed, so the grant is pinned to its
code hash and must be given again after every `hc update`.

A dedicated session (for example `HC_SESSION=topics`) keeps topic terminals
apart from interactive hc use and lets the agent own that core alone. Its
`config.toml` should set `notes = false`, so hc never types notes into a
terminal; the launcher also starts every topic with `--no-parent --no-notify`.

## Restart and failure semantics

| Event | Topic Claudes | What the proxy does |
| --- | --- | --- |
| `hc server restart` | keep running (same pids, status kept) | nothing; the new core runs in the caller's environment |
| Core crash | keep running; the holder starts a new core within a second | nothing |
| `launchctl kickstart -k` or removal of the core's job | keep running; the holder restarts the core outside the job, and launchd's own instances exit 0 while it runs | nothing |
| `hc server stop` | end (topic terminals are not `--keep`) | the next message starts a core and resumes each conversation |
| Holder loss | end; terminals finish with reason `holder_lost` | the next message resumes the conversation |

The holder (`herdr-core hold`) owns the terminals' PTYs in its own process
group, which is why a core restart or a launchd job kill leaves programs
running. Only the holder's death ends them.

**Logout and login** (reasoned, not exercised): logout ends the user's
processes, holder included, so every topic terminal ends. At login launchd
starts the core and the proxy; the proxy finds no live terminal for its
registered topics, and each topic resumes on its next message. A `--keep`
terminal would return as a bare shell, which reads as missing; the launcher
never uses `--keep`.

## Known gaps

- The launcher's dialog watcher answers only the development-channel dialog.
  The spawn directory must already be a trusted folder, as on every backend.
- Once, a message sent right after a holder loss started nothing: it stayed
  queued and was delivered when the next message started the topic. Two timed
  repeats respawned at once; the cause is unknown.
