# agent-board v0.2: design

Issue-board-driven orchestration of local Claude Code worker agents. Adding a
configured label to an issue spawns a worker for it; removing the label reaps
the worker (stopped, transcript kept); re-adding the label resumes the same
session. The label is the whole trigger: issue/ticket STATE is never consulted,
so a worker outlives its ticket being auto-moved to Done by PR activity and can
still do post-merge work.

Two pluggable dimensions, any pairing of which works: **sources** `github`
(DEFAULT) | `linear`, and **runtimes** `tmux` (DEFAULT) | `herdr`. The native
claude-bg runtime (`claude --bg` / `claude agents` / `claude respawn`) is
REMOVED in v0.2; workers are foreground `claude` processes hosted in panes
(tmux windows or herdr panes).

## Architecture: ports and adapters

```
scripts/
  poll.sh                    composition root + CLI
  lib.sh                     provider-agnostic core
  adapters/
    source-github.sh         src_* implementation (gh)
    source-linear.sh         src_* implementation (linear CLI)
    runtime-tmux.sh          rt_* implementation (tmux, default)
    runtime-herdr.sh         rt_* implementation (herdr)
```

**Composition root: `scripts/poll.sh`.** Loads config, sources `lib.sh` plus
the two selected adapters, validates the adapter contracts (below), then runs
the poll pass or a CLI command: `once`, `status`, `spawn`, `resume`, `reap`,
`install`, `uninstall`, `config-init`, `help`.

**Core: `scripts/lib.sh`.** Provider-agnostic only:

- config access: `ab_get` / `ab_get_list`
- task-to-session map (persisted JSON; reap keeps entries)
- single-flight poll lock (atomic `mkdir`, stale-pid reclaim)
- logging (`ab_log`), `ab_safe`, `ab_workspace_root` (empty config falls back
  to `$HOME/workspace`), env scrubbing (`AB_SCRUB_VARS` / `ab_scrub_env`)
- NEW: a shared **worker-argv builder** used by BOTH pane runtimes:
  `ab_build_worker_argv` sets the globals `AB_EXE` (the `agent_cmd` first
  element, default `claude`) and the array `AB_ARGV` holding, in
  order: the `agent_cmd` tail, `--plugin-dir <plugin_dir>`, `--permission-mode
  <permission_mode>` (uniform default `acceptEdits` for every runtime),
  `--dangerously-skip-permissions` when `dangerously_skip` is true,
  `--append-system-prompt <house_rules>` when `house_rules` is non-empty, and
  `--agent <persona>` (persona = `worker_subagent`, empty -> the source's
  `src_default_persona`). `house_rules` therefore applies to ALL runtimes.
  Leading `~/` in `agent_cmd` elements, `plugin_dir`, and `workspace_root` is
  expanded to `$HOME` (schedulers run without a shell to do it).
  tmux execs `AB_EXE` directly; herdr derives the executable from `--kind
  <agent_kind>` and only warns when `AB_EXE`'s basename disagrees with it.

Dead code to delete from core: `ab_session_name` and the `session_prefix`
config key (nothing calls them).

**Source port (`src_*`).** BOTH sources implement ALL of:

| Function | Contract |
| --- | --- |
| `src_deps` | space-separated dependency list |
| `src_spawn_candidates` | one task id per line: labelled tasks eligible to run |
| `src_has_label <id>` | rc 0 = has label; 1 = label lost OR issue definitively gone; 2 = unknown (query failed) |
| `src_last_actor_is_me <id>` | rc 0 iff the newest action on the issue is the operator's; fails closed |
| `src_kickoff_context <id>` | short kickoff text for the worker's first prompt |
| `src_title <id>` | issue title (github grows this via `gh issue view --json title`) |
| `src_default_persona` | NEW: the source's persona name (github -> `issue-agent`, linear -> `linear-worker`) |

The contract comment lives ONCE (in `poll.sh` or a dedicated header file), not
per-adapter.

**Runtime port (`rt_*`).** `rt_deps`, `rt_status <id>` (prints
`absent|running|stopped`), `rt_running_count`, `rt_spawn <id> <kickoff>`,
`rt_resume <id>` (rc 2 = no saved session id), `rt_reap <id>`, `rt_list`.

Runtimes are PURE PANE HOSTS: they never clone repos and never pick personas.
Persona resolution happens in `poll.sh` or the argv builder: config
`worker_subagent` if non-empty, else `src_default_persona`. This binds the
default persona to the SOURCE, fixing the v0.1 cross-pairing bugs where the
runtime chose a persona shaped for the wrong source.

**Contract validation at adapter load.** After sourcing each adapter, `poll.sh`
checks every required function exists via `declare -F`; any missing function
exits loudly, naming the adapter and the missing functions. A test seam:
`AGENT_BOARD_ADAPTER_DIR` env var overrides the adapters directory (default
`$HERE/adapters`).

## Label semantics (identical across sources)

**Spawn candidates.** github: issues AUTHORED by the operator (`gh_login`,
auto-detected via `gh api user` when empty) carrying the label, found by one
cross-repo `gh search issues`; PRs excluded; no repo allowlist (only repos the
operator can label are reachable). linear: issues with `assignee.isMe` carrying
the label (unchanged).

**`src_has_label` gone-issue alignment.** A DEFINITIVELY missing issue returns
1 (worker reaped) on both sources. github: distinguishes not-found from outage
by matching gh stderr against the GraphQL "Could not resolve" error; not-found
-> 1, anything else -> 2 (fails closed, worker keeps running). linear:
unchanged (query resolved empty -> 1; query failure -> 2).

**Last-actor spawn guard: REAL ON BOTH sources.** The newest action on the
issue must be the operator's own; fails closed on bot actors, other users, or
missing data. linear: unchanged (viewer id vs newest of history/comments).
github NEW: one `gh api graphql` query fetching viewer login plus the issue's
`timelineItems(last: 1)` actor and `comments(last: 1)` author; take the newer
of the two and compare its login to the operator's.

The guard gates spawn AND resume. Consequence, by design: crash auto-recovery
pauses while someone else's action is newest on the issue, and resumes once the
operator acts again.

**Kickoff parity.** Both kickoffs are short task pointers (id, URL, title) and
BOTH end with a do-not-merge/do-not-deploy line. The persona carries the full
protocol; the kickoff never does.

## Personas (source-bound, self-provisioning)

Both personas are self-provisioning: no runtime clones anything.

**`agents/issue-agent.md` (github).** Now self-provisions like linear-worker:
clone the target repo under the workspace root if absent (`gh repo clone`),
fetch, per-issue worktree on a feature branch, do the work, open a draft PR
with `Closes #N`, `open <pr-url>`, then watch the PR for AI/automated review
only. Hard rules unchanged: never comment on the issue; the only automated
comments anywhere are replies to AI/automated PR review, each ending with the
existing verbatim sign-off line; never merge, never mark ready, never push
main, never deploy; no secrets.

**`agents/linear-worker.md`.** GENERICIZED for a public plugin: no references
to the operator's global `~/.claude/CLAUDE.md`, no literal `~/workspace` paths.
It works under the workspace root its pane starts in (runtimes set pane cwd to
`ab_workspace_root`), and the per-issue worktree flow is described
self-contained inside the persona. Behavior otherwise unchanged.

## Runtimes

**tmux (NEW, DEFAULT).** One shared detached tmux session (config
`tmux_session`, default `agent-board`), created on demand. One WINDOW per task;
window name = `ab_safe(id)`; the window name is the identity.

- spawn: mint a uuid session id, build argv via the shared builder, then
  `tmux new-window -d -c <workspace_root>` running
  `env -u <scrub vars> claude <argv> --session-id <sid> '<kickoff>'`. The
  kickoff is claude's positional prompt argument. tmux joins command args with
  spaces and hands them to a shell, so build the command by `printf '%q '`-ing
  every word into one correctly quoted string; never interpolate raw text.
- targeting: tmux target names prefix-match by default; always address windows
  with the exact-match form `<session>:=<name>` (kill-window, list checks).
- status: `running` iff the session exists AND a window with that name exists;
  `stopped` if a session id is mapped but no window; `absent` if no map entry.
- reap: `tmux kill-window` (session id kept in the map). resume: same as spawn
  but with `--resume <sid>` plus a nudge prompt; rc 2 when no saved sid.
- crash recovery: a crashed claude closes its window, so status reads
  `stopped`, and the next pass auto-resumes it. This IS the crash-recovery
  mechanism (subject to the last-actor guard, above).
- operator attach: `tmux attach -t agent-board`.

**herdr (kept).** Behavior as today: one shared herdr session, one workspace
per task labelled with a title slug, agent name = `ab_safe(id)`, self-minted
session id, `agent_pane_busy` retry on start. Minus what moved to core: argv
assembly uses the shared builder, and the `worker_subagent` default no longer
lives in this adapter.

## Config contract (`config.example.json`)

| Key | Default | Applies to | Notes |
| --- | --- | --- | --- |
| `source` | `github` | all | `github` or `linear` |
| `runtime` | `tmux` | all | `tmux` or `herdr` |
| `label` | `agent` | all | the trigger label |
| `cap` | `3` | all | max concurrent workers |
| `poll_seconds` | `90` | all | scheduler interval |
| `workspace_root` | `""` | all | empty -> `$HOME/workspace`; pane cwd |
| `worker_subagent` | `""` | all | empty -> the source's default persona |
| `agent_cmd` | `["claude"]` | all | full argv; first element is the executable |
| `permission_mode` | `acceptEdits` | all | uniform default across runtimes |
| `dangerously_skip` | `false` | all | adds `--dangerously-skip-permissions` |
| `house_rules` | `""` | all | appended via `--append-system-prompt` |
| `plugin_dir` | `""` | all | adds `--plugin-dir` |
| `tmux_session` | `agent-board` | tmux | shared session name |
| `herdr_session` | `agent-board` | herdr | shared session name |
| `agent_kind` | `claude` | herdr | herdr `--kind` |
| `gh_login` | `""` | github | empty -> auto-detect via `gh api user` |

REMOVED keys: `session_prefix`, `worktree`, `agent_name_prefix`, `workdir`
(managed clones are gone; personas self-provision).

## Lifecycle

```
operator adds <label> to an issue
      |
      v                     guard: last actor must be the operator (else skip)
poll pass ---- under cap? --no--> queued, retried next pass
      | yes
      v
rt_status: absent -> rt_spawn (new sid)     stopped -> rt_resume (saved sid)
      |                                        ^
      v                                        | crash: window/pane gone ->
worker: provision -> work -> draft PR -> answer AI review
      |
operator removes <label> --> rt_reap (pane closed, sid + transcript kept)
      |
operator re-adds <label> --> rt_resume with the SAME session
```

Each `once` pass runs two loops: the SPAWN/RESUME loop over
`src_spawn_candidates` (re-entrant: running is a no-op) and the REAP loop over
the tracked map via the fresh per-issue `src_has_label` (so unlabel-to-stop
does not wait on search-index lag; a freshly labelled issue may be picked up
one pass later, which is fine).

## Concurrency and locking

- **Single-flight poll lock**: each pass takes an atomic `mkdir` lock for its
  whole duration; an overlapping pass skips; a stale lock (dead pid) is
  reclaimed. Two passes never act on one task.
- **Identity dedup**: runtime identity is deterministic (tmux window name /
  herdr agent name = `ab_safe(id)`), so a live worker reads `running` and is
  never double-spawned.
- **Cap**: spawns and resumes both count against `cap`; the rest queue for the
  next pass.

## Safety

- Workers act on feature branches in per-issue worktrees and produce a draft
  PR; they never merge, mark ready, push main, or deploy. Both kickoffs and
  both personas state this.
- The last-actor guard (both sources, spawn AND resume) plus github's
  authored-by filter / linear's assignee filter keep other people's actions
  from driving dispatch. All guards fail closed.
- Reap fails closed: an unreadable label keeps the worker running; only a
  definite "label gone or issue gone" reaps.
- Workers never comment on issues; their only automated comments are replies to
  AI/automated PR review.

## Tests

`tests/run.sh`, plain bash (no bats). Stub adapters in `tests/stubs/`
(`source-stub.sh`, `runtime-stub.sh`) driven by fixture env vars/files, with
`AGENT_BOARD_CONFIG`, `AGENT_BOARD_STATE`, `AGENT_BOARD_LOCK`, and
`AGENT_BOARD_ADAPTER_DIR` pointed at a temp dir. Coverage: spawn under cap;
cap-reached queuing; resume rc 2 falls through to fresh spawn; reap on label
loss; keep-running on unknown (rc 2); guard skip; lock single-flight;
contract-validation failure on an incomplete adapter. `shellcheck` clean across
`scripts/`.

## Docs plan

- README rewrite: lead with github+tmux, sources x runtimes matrix, full config
  table with an applicability column, per-runtime lifecycle/observe commands,
  safety section matching the real guards.
- SKILL.md rewrite: source/runtime aware; do NOT promise that workers reply to
  human PR comments (they only auto-reply to AI/automated review).
- Root README + `marketplace.json` + `plugin.json` descriptions aligned (no
  "comment progress" wording). Version `0.2.0`.

## Conventions

- bash 3.2 compatible (macOS `/bin/bash`): no associative arrays, no
  `mapfile`, guard every possibly-empty array expansion under `set -u`
  (`${arr[@]+"${arr[@]}"}`).
- NO em dashes anywhere (use hyphens, colons, parentheses). The one exception
  is the worker sign-off line, kept verbatim as it exists in the personas.
- Comments are terse and current-state only: no history, no incident narration.
- Nothing in the plugin references the operator's personal environment (no
  personal paths, machine names, or private repo identifiers).
