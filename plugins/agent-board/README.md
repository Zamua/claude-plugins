# agent-board

Turn your GitHub issues into a board of background Claude Code agents. A local
poller picks up issues you've labelled, launches one background agent per issue
(each in its own git worktree), and those agents do the work, post progress as
comments, and open a pull request. You stay the orchestrator: you review and
merge. Everything runs locally and is visible in one place via `claude agents`.

It's built entirely on native Claude Code primitives - background agents
(`--bg`), worktrees (`--worktree`), the agents view (`claude agents`), session
resume (`respawn`/`--resume`), and the Monitor tool for the watch loops. There
is no custom agent runtime and nothing runs in the cloud.

## How it works

```
you label an issue `agent`  ─▶  poller dispatches a background worker (its own worktree)
                                    │
                                    ├─ comments "started", does the work on a branch
                                    ├─ opens a PR (Closes #N), comments the link
                                    └─ watches the issue + PR for your comments (Monitor), iterates
you review + merge the PR  ─────▶  issue closes  ─▶  poller stops the worker (transcript kept)
you reopen the issue       ─────▶  poller resumes the SAME session that worked it
```

- **Eligibility:** any issue in **any of your repos** that's authored by you,
  carries the label (default `agent`), and is open. Discovery is a cross-repo
  GitHub search - no repo list to maintain; the repo is cloned on demand into a
  managed `workdir`.
- **Concurrency:** a configurable cap bounds how many agents run at once.
- **Resume:** the issue→session map means reopening an issue resumes its exact
  agent; stopping never deletes a transcript.
- **You merge:** workers never merge or deploy - their entire output is a PR on
  a branch.

## Install

```
/plugin marketplace add <owner>/<marketplace-repo>
/plugin install agent-board@<marketplace-name>
```

Or develop locally: `claude --plugin-dir /path/to/agent-board`.

Requires: `claude`, `gh` (authenticated), `jq`, `git`, and a Bash shell. macOS
uses launchd for scheduling; other platforms use cron.

## Configure

```
"${CLAUDE_PLUGIN_ROOT}/scripts/poll.sh" config-init      # writes a starter config
```

Edit `~/.config/agent-board/config.json`:

| key | default | meaning |
| --- | --- | --- |
| `label` | `agent` | only issues with this label are dispatched |
| `gh_login` | `""` | whose issues to run; empty = auto-detect via `gh api user` |
| `workdir` | `""` | where agent-board keeps its own per-repo clones; empty = `~/.local/share/agent-board/repos` |
| `cap` | `3` | max concurrent agents |
| `poll_seconds` | `90` | how often the scheduler runs a pass |
| `worktree` | `true` | give each agent its own git worktree |
| `permission_mode` | `acceptEdits` | the workers' Claude permission mode |
| `dangerously_skip` | `false` | add `--dangerously-skip-permissions` to workers (full unattended autonomy) |
| `house_rules` | `""` | extra system-prompt text appended to every worker (your repo conventions, guards) |
| `agent_name_prefix` | `agent-board` | display-name prefix for the agents view |

> **Unattended autonomy:** a background worker can't answer permission prompts.
> To run fully hands-off it needs `permission_mode: "bypassPermissions"` (or
> `dangerously_skip: true`). Its blast radius is still bounded to a branch + a
> PR (it never merges or deploys, and only your own issues are dispatched), but
> turn this on deliberately. Start with a small `cap` and raise it once you've
> watched real memory/CPU use - many agents running heavy builds at once can
> exhaust the host.

The repo must have the label: `gh label create agent` once per repo.

## Run it

```
poll.sh once          # one pass now (dispatch / resume / teardown)
poll.sh status        # the board: eligible issues, running agents, the map
poll.sh install       # arm the scheduler (launchd on macOS; prints a cron line otherwise)
poll.sh uninstall     # stop the scheduler
```

From the orchestrator session, the `/agent-board:board` skill wraps all of this
plus the review + merge flow.

## Lifecycle commands

| | |
| --- | --- |
| dispatch one issue now | `poll.sh dispatch <repo_path> <number>` |
| stop an agent (keep transcript) | `poll.sh stop <owner/repo#N>` |
| resume a stopped agent | `poll.sh resume <owner/repo#N>` |
| watch one live | `claude attach <session-id>` / `claude logs <session-id>` |
| see all agents | `claude agents` |

## Safety

- Workers run in an isolated worktree on a feature branch and produce only a PR.
- They are instructed never to merge, push to `main`, or deploy.
- Only issues authored by the configured user are ever picked up.
- Merge + release stay with you, the human orchestrator.

## License

MIT.
