# agent-board — design

Self-hosted orchestration of background Claude Code agents through a GitHub
issue board. One persistent **orchestrator** (the operator's long-lived chat)
plus N **ephemeral workers**, each a native background agent bound to one
issue. Coordination, progress, and review all happen on the issue + its PR.

## Goals

- Keep ONE long continuous chat (the orchestrator) while dispatching many
  independent work sessions.
- Dispatch is driven by the issue board: labelling an issue makes it a running
  background agent, unlabelling it stops that agent (the session is preserved, so
  re-labelling resumes it with context intact). A worker that stops while its
  issue still carries the label (e.g. a crash) is respawned by the poller. Git
  worktrees and branches are never touched by the harness; cleanup is manual.
- Everything runs LOCALLY on the operator's machine (no cloud agents), visible
  and manageable in one place via `claude agents`.
- Package the whole thing as a Claude Code **plugin** vended from a personal
  **marketplace** repo, so it installs with `/plugin install`.

## Native primitives (verified on claude 2.1.195)

The design leans entirely on shipped Claude Code features — no custom agent
runtime:

| Need | Native mechanism |
| --- | --- |
| Launch a background agent | `claude --bg --name issue-<n> "<prompt>"` |
| See/manage all agents in one view | `claude agents` (TUI) / `claude agents --json` (programmatic) |
| Isolated working tree per agent | `claude --worktree` (auto worktree under `.claude/worktrees/`, branch `worktree-<name>`) |
| Resume a stopped agent with context intact | `claude respawn <id>` / `claude --resume <id>` |
| Remove from the view, keep the transcript | `claude rm <id>` (transcript retained, resumable) |
| Stop an agent | `claude stop <id>` |
| In-session polling loops | the **Monitor** tool (session-scoped; fine here because the agent session lives until the label comes off) |

State lives in `~/.claude/jobs/<id>/`; transcripts in `~/.claude/projects/`.

## Roles

**Orchestrator** — the operator's persistent session. Creates/triages issues,
reviews PRs, and is the ONLY actor that merges + releases. Drives the board via
the plugin's `board` skill (`/agent-board:board ...`).

**Worker** — one background agent per eligible issue. On launch it immediately:
1. Reads the issue.
2. Arms two **Monitor** loops — one watching the issue's comments, one watching
   its PR's comments — so a new comment from the operator wakes it.
3. Does the work in its own worktree/branch, posting progress as issue comments.
4. Opens a PR (draft until it believes it's done), links it to the issue.
5. Addresses review comments in a loop; NEVER merges, NEVER deploys.
6. Ends when the operator removes the `agent` label: the poller stops the agent
   and preserves its session, so re-labelling resumes the same worker. Git
   worktrees and branches are left alone.

## Eligibility (the poller's filter)

The label is the whole trigger. An issue is dispatched if BOTH hold:
- authored by the operator (`--author <login>`) — never run agents on issues
  opened by other people;
- carries the single `agent` label.

Losing the label is the reap trigger, so adding and removing it are the two
operator gestures that start and stop a worker. Issue state is deliberately not a
predicate: the tracker moves state on its own from PR activity (closed on merge,
Done in Linear), while post-merge work like a release or an observability check is
still the worker's. Reaping fails closed: if the source can't say whether the
label is there, the worker keeps running.

Discovery is a single CROSS-REPO search across every repo the operator can see -
no allowlist to maintain:

`gh search issues --author <login> --label agent` (excludes PRs)

The operator can only add the `agent` label on repos they have write access to,
so the label requirement naturally scopes dispatch to their own repos. Each repo
is cloned on demand into the managed `workdir` and the worker's worktree is made
there, isolated from the operator's working checkouts. NB GitHub search indexes a
new issue within a few seconds, so discovery is picked up on the next pass.

## Lifecycle

```
issue gets the agent label (by me)
   └─ poller: under cap?  ── no ─> queue (retry next tick)
          │ yes
          ▼
   claude --bg --worktree --name issue-<n>  (record issue→session-id)
          ▼
   worker: work → open draft PR → reply to automated PR review
          ▼  (operator reviews PR; comments wake the worker; it iterates)
   operator merges PR                       (point 8 — merge is the orchestrator's)
          ▼  worker lives on for whatever the merge doesn't cover (release, observability)
   operator removes the agent label → poller stops the worker (transcript kept)
          ▼
   label re-added → poller resumes THAT session (claude respawn <saved-id>)

   worker stops while the label is still on (crash) ──> poller resumes it (auto-recovery)
```

The issue→session-id map is persisted at `~/.config/agent-board/sessions.json`
(`{ "<repo>#<number>": "<session-id>" }`) so re-labelling can resume and the
poller can tell "already running" from "needs (re)launch".

## Concurrency cap (operator point 5)

Configurable (default **3**). Start low and raise once you've watched real
memory/CPU use on your host: many agents running heavy builds/tests at once can
exhaust RAM, while idle agents parked on a monitor are light. The poller counts
running agents via `claude agents --json` and only launches while `running <
cap`; the rest wait for the next tick. A future refinement could add a separate
"heavy work" semaphore distinct from the raw agent count.

## Concurrency, locking, and GitHub consistency

Two agents must never run for the same issue. Two guards enforce it:

- **Single-flight poll lock.** Each `poll.sh once` acquires an atomic `mkdir`
  lock (`~/.config/agent-board/.poll.lock`) and holds it for the whole pass, so
  an overlapping scheduled pass (or a manual run) skips rather than racing. A
  lock left by a crashed pass (pid gone) is reclaimed.
- **Name dedup.** Each issue's agent has a deterministic name
  (`<prefix>-<slug>-<number>`); before launching, the poller checks
  `claude agents` for that name and adopts the existing agent instead of
  starting a second one.

**Agent identity.** `--session-id` is ignored by `--bg` (claude assigns its own),
so after launch the poller captures the agent's short `id` from
`claude agents --json` by name and stores `key -> id`. That short id drives
stop / respawn / resume for the agent's whole life.

**GitHub read-after-write lag.** The cross-repo search (the eligible scan) lags
`gh issue view` (per-issue) by seconds after a label change. So a pass runs two
loops: the reap loop reconciles KNOWN issues (the map) via the fresh per-issue
endpoint, making unlabel->stop lag-free; the spawn loop scans the search only for
NEW issues (a freshly labelled issue may be picked up one pass later, which is
fine).

## Components (all inside the plugin)

```
plugins/agent-board/
  .claude-plugin/plugin.json       manifest
  agents/
    issue-agent.md                 the worker persona (arm monitors, work, PR, never merge)
  skills/
    board/SKILL.md                 orchestrator ops: status / dispatch / stop / resume / install
  scripts/
    poll.sh                        the poller + management CLI
    watch-comments.sh              the Monitor watcher: emits on a new issue/PR comment
    lib.sh                         shared helpers (config, gh wrappers, session map)
  launchd/
    com.agent-board.poller.plist   LaunchAgent template (runs `poll.sh once` on an interval)
  config.example.json              the config contract
  docs/DESIGN.md                   this file
  README.md
```

The worker is launched with `claude --bg --agent issue-agent` so its protocol is
the subagent's system prompt; the poller passes a short kickoff prompt naming the
issue. Config: `~/.config/agent-board/config.json` — `label`, `gh_login` (empty =
auto-detect via `gh api user`), `workdir` (where per-repo clones live),
`cap`, `poll_seconds`, `worktree`, `permission_mode`, `dangerously_skip`,
`house_rules`, `agent_name_prefix`. See `config.example.json`.

## Safety

- Workers act in an isolated worktree/branch and produce a **PR** — their blast
  radius is "a PR on a branch." They never merge, never deploy, never touch
  main directly.
- Each worker's brief carries the operator's standing guards (no secrets in
  diffs, staging-gate awareness, money-ops need human ok). Workers run with
  normal permissions — NOT `--dangerously-skip-permissions` for anything that
  pushes to main or deploys.
- Only issues authored by the operator are ever dispatched (Sybil guard at the
  board level).
- Merge + release stays with the human orchestrator.

## Build / rollout plan (staged, reversible)

1. **Local build + validate**: author the plugin, `claude plugin validate`,
   load via `claude --plugin-dir ./plugins/agent-board`.
2. **Single-agent e2e** (cap=1): one test issue → poller launches one worker →
   it opens a PR → operator reviews → unlabel → stop → re-label → resume.
3. **Create the marketplace repo** `Zamua/claude-plugins`, push, `/plugin
   marketplace add Zamua/claude-plugins`, `/plugin install agent-board@...`.
4. **Arm the poller** (load the LaunchAgent) with a low cap; raise after a soak.

Steps 3–4 are the "goes live" checkpoint — nothing is created on GitHub or
armed before the operator signs off on the local build.
