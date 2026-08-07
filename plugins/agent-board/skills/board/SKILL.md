---
description: Operate the agent-board from the orchestrator session - see the board's status, dispatch / stop / resume issue workers, and review + merge their PRs. Use when the user asks to check the agent board, run a poll pass, start or stop a worker for an issue, or review what the workers have produced.
---

# agent-board: orchestrator operations

You are the **orchestrator**: the persistent session that manages the board.
Workers do the per-issue work in their own panes (tmux windows or herdr panes)
and open draft PRs; you triage issues, watch progress, and are the ONLY actor
that merges + releases.

All management runs through one script. Use the plugin root:

```
P="${CLAUDE_PLUGIN_ROOT}/scripts/poll.sh"
```

## Common operations

- **Status of the board** (eligible issues, running workers, the task-session
  map): `"$P" status`
- **Run one poll pass now** (spawn newly labelled / resume stopped / reap
  unlabelled): `"$P" once`
- **Force-dispatch a specific issue** right now: `"$P" spawn <id>`
- **Stop a worker** (keeps its transcript; resume later): `"$P" reap <id>`
- **Resume a stopped worker** (e.g. after re-adding the label): `"$P" resume <id>`

Issue ids: `owner/repo#N` for the github source, the issue identifier
(e.g. `ENG-42`) for linear.

## Observing workers

- runtime `tmux` (default): `tmux attach -t agent-board`; one window per
  issue, window name = the sanitized issue id. Detach with `C-b d`.
- runtime `herdr`: open the shared herdr session (default `agent-board`); one
  workspace per issue.

## Creating work

The label is the whole trigger: a labelled issue gets a worker, an issue that
loses the label gets reaped. Issue state is never consulted. Per source:

- **github** (issues you author):

  ```
  gh issue create --repo <owner/repo> --label agent --title "..." --body "..."
  ```

  The label must already exist on the repo: `gh label create agent` once.
- **linear** (issues assigned to you): assign the issue to yourself and add
  the label in Linear. Create the label in the workspace once if it is new.

The poller picks it up on its next pass, or run `"$P" once` to dispatch now.

## Review feedback and merging (your job, never the worker's)

Workers open draft PRs and never merge. They auto-reply ONLY to AI/automated
PR review; they do not watch for or respond to human PR comments. To get
feedback to a worker, either:

- leave it as PR comments for the AI-reviewer flow (an automated review the
  worker will answer), or
- deliver it directly: attach to the worker's pane and type it there.

When the PR is good and CI is green, **you** merge (`gh pr merge`). Merging
does NOT end the worker: post-merge work like a release or an observability
check is still its job. Stop it by removing the label; the next pass reaps it
and its transcript is retained. Re-add the label and the next pass resumes the
exact same session that worked it.

## Setup / lifecycle

- First-time setup: `"$P" config-init`, then edit
  `~/.config/agent-board/config.json` (pick `source` and `runtime`; defaults
  are github + tmux).
- Arm the scheduler: `"$P" install` (launchd on macOS, prints a cron line
  otherwise).
- Stop the scheduler: `"$P" uninstall`.

Never raise the concurrency cap blindly: many workers running heavy builds at
once can exhaust the host's memory. Raise it gradually and watch resource use.
