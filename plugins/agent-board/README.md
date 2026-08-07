# agent-board

Turn your issue board into a board of local Claude Code worker agents. A poller
watches for issues carrying a trigger label; each labelled issue gets its own
worker: a foreground `claude` process hosted in its own pane (a tmux window by
default) that provisions its repo, works in a per-issue worktree, and opens a
draft PR. You stay the orchestrator: you review and merge.

The default pairing is **GitHub + tmux**. Sources and runtimes are pluggable
adapters, and any pairing works.

## How it works

The label is the whole trigger. Issue state is never consulted, so a worker
outlives its ticket being auto-moved to Done by PR activity and can still do
post-merge work (a release step, an observability check).

```
you add the label           ->  next poll pass spawns a worker pane
                                  (guard: the newest action on the issue must be yours)
                                  |- clones the repo if absent
                                  |- works on a branch in a per-issue worktree
                                  |- opens a draft PR (Closes #N)
                                  '- replies to AI/automated PR review only
you review + merge the PR   ->  the worker keeps running; post-merge work is still its job
you remove the label        ->  next pass reaps the pane (session id + transcript kept)
you re-add the label        ->  next pass resumes the SAME session
worker crashes (pane gone)  ->  next pass auto-resumes it
```

## Sources x runtimes

|                    | runtime `tmux` (default)     | runtime `herdr`             |
| ------------------ | ---------------------------- | --------------------------- |
| source `github` (default) | works                 | works                       |
| source `linear`    | works                        | works                       |

- **The source decides which issues are eligible.** `github`: issues you
  **authored** carrying the label, found by one cross-repo search (no repo
  list to maintain). `linear`: issues **assigned to you** carrying the label.
- **The runtime decides where the worker process lives.** `tmux`: one window
  per issue inside one shared detached session. `herdr`: one workspace + pane
  per issue inside one shared herdr session. Runtimes are pure pane hosts:
  cloning, worktrees, and branches are the worker's own job.

## Install

```
/plugin marketplace add <owner>/<marketplace-repo>
/plugin install agent-board@<marketplace-name>
```

Or develop locally: `claude --plugin-dir /path/to/agent-board`.

## Dependencies

`claude`, `git`, and a Bash shell always, plus the two adapters you select:

| adapter          | needs                          |
| ---------------- | ------------------------------ |
| source `github`  | `gh` (authenticated), `jq`, `git` |
| source `linear`  | `linear` CLI, `jq`             |
| runtime `tmux`   | `tmux`, `jq`, `uuidgen`        |
| runtime `herdr`  | `herdr`, `jq`, `uuidgen`       |

macOS uses launchd for scheduling; other platforms use cron (minute resolution,
so `poll_seconds` rounds down to whole minutes there).

## Configure

```
"${CLAUDE_PLUGIN_ROOT}/scripts/poll.sh" config-init      # writes a starter config
```

Edit `~/.config/agent-board/config.json`:

| key | default | applies to | meaning |
| --- | --- | --- | --- |
| `source` | `github` | all | `github` or `linear` |
| `runtime` | `tmux` | all | `tmux` or `herdr` |
| `label` | `agent` | all | the trigger: issues carrying it are dispatched, issues that lose it are reaped |
| `cap` | `3` | all | max concurrent workers (spawns and resumes both count) |
| `poll_seconds` | `90` | all | how often the scheduler runs a pass |
| `workspace_root` | `""` | all | pane working directory; empty = `~/workspace` |
| `worker_subagent` | `""` | all | worker persona; empty = the source's default (`issue-agent` for github, `linear-worker` for linear) |
| `agent_cmd` | `["claude"]` | all | full worker argv; first element is the executable |
| `permission_mode` | `acceptEdits` | all | the workers' Claude permission mode |
| `dangerously_skip` | `false` | all | adds `--dangerously-skip-permissions` (full unattended autonomy) |
| `house_rules` | `""` | all | extra system-prompt text appended to every worker (your repo conventions, guards) |
| `plugin_dir` | `""` | all | passed to workers as `--plugin-dir` |
| `tmux_session` | `agent-board` | tmux | shared tmux session name |
| `herdr_session` | `agent-board` | herdr | shared herdr session name |
| `agent_kind` | `claude` | herdr | herdr `--kind` |
| `gh_login` | `""` | github | whose issues to run; empty = auto-detect via `gh api user` |

The label must exist before you can apply it:

- github: `gh label create agent` once per repo.
- linear: create the label in your Linear workspace (or team) once.

> **Unattended autonomy:** a worker pane runs hands-off between your attaches,
> so a pending permission prompt stalls that worker until you attach and answer
> it. To run fully unattended it needs `permission_mode: "bypassPermissions"`
> (or `dangerously_skip: true`). The blast radius is still bounded to a branch
> plus a draft PR (workers never merge or deploy, and only your own issues are
> dispatched), but turn this on deliberately. Start with a small `cap` and
> raise it once you have watched real memory/CPU use: many workers running
> heavy builds at once can exhaust the host.

## Run it

```
poll.sh once          # one pass now (spawn / resume / reap)
poll.sh status        # the board: eligible issues, running workers, the map
poll.sh install       # arm the scheduler (launchd on macOS; prints a cron line otherwise)
poll.sh uninstall     # stop the scheduler
```

From the orchestrator session, the `/agent-board:board` skill wraps all of this
plus the review + merge flow.

## Lifecycle commands

Issue ids: `owner/repo#N` for the github source, the issue identifier
(e.g. `ENG-42`) for linear.

| | |
| --- | --- |
| dispatch one issue now | `poll.sh spawn <id>` |
| stop a worker (keep transcript) | `poll.sh reap <id>` |
| resume a stopped worker | `poll.sh resume <id>` |

Observe workers:

- runtime `tmux`: `tmux attach -t agent-board`; one window per issue, window
  name = the sanitized issue id. Detach with `C-b d`.
- runtime `herdr`: open the shared herdr session (default `agent-board`); one
  workspace per issue.

## Safety

- Dispatch is filtered to your own work: github runs only issues you authored;
  linear runs only issues assigned to you.
- A last-actor guard (both sources) gates spawn AND resume: the newest action
  on the issue must be yours. It fails closed on bot actors, other users, or
  missing data, so nobody else's activity can start or restart a worker. One
  consequence: crash auto-recovery pauses while someone else's action is
  newest on the issue, and resumes once you act again.
- Reap fails closed: only a definite "label gone or issue gone" reaps a
  worker; an unreadable label (query failure) keeps it running.
- Blast radius: workers act on feature branches in per-issue worktrees and
  produce a draft PR. They never merge, mark a PR ready, push main, or deploy.
- Workers never comment on issues; their only automated comments are replies
  to AI/automated PR review, each carrying a sign-off line marking it as
  automated.

## License

MIT.
