---
description: Operate the agent-board from the orchestrator session - see the board's status, dispatch / stop / resume issue agents, and review + merge their PRs. Use when the user asks to check the agent board, run a poll pass, start or stop an agent for an issue, or review what the background agents have produced.
---

# agent-board — orchestrator operations

You are the **orchestrator**: the persistent session that manages the board.
Background workers do the per-issue work and open PRs; you triage issues, watch
progress, and are the ONLY actor that merges + releases.

All management runs through one script. Use the plugin root:

```
P="${CLAUDE_PLUGIN_ROOT}/scripts/poll.sh"
```

## Common operations

- **Status of the board** (eligible issues, running agents, the issue→session map):
  `"$P" status`
- **Run one poll pass now** (dispatch new / resume reopened / tear down closed):
  `"$P" once`
- **Force-dispatch a specific issue** right now:
  `"$P" dispatch <repo_path> <issue_number>`
- **Stop an agent** (keeps its transcript; resume later):
  `"$P" stop <owner/repo#N>`
- **Resume a stopped agent** (e.g. after reopening an issue):
  `"$P" resume <owner/repo#N>`
- **Watch a worker live** / read its output:
  `claude attach <session-id>` (interactive) or `claude logs <session-id>`
- **See all background agents** (the native view): `claude agents`

## Creating work

A worker is dispatched only when an issue is: authored by the configured user,
carries the configured label (default `agent`), and is open. To queue work:

```
gh issue create --repo <owner/repo> --label agent --title "..." --body "..."
```

(The label must already exist on the repo: `gh label create agent` once.) The
poller picks it up on its next pass, or run `"$P" once` to dispatch immediately.

## Reviewing + merging (your job, never the worker's)

Workers open PRs and respond to review comments but never merge. You:

1. Review the PR (`gh pr view <n>`, `gh pr diff <n>`), or summarize it for the
   user to decide.
2. Leave review comments on the PR - the worker is watching and will respond.
3. When it's good and CI is green, **you** merge (`gh pr merge`) and the issue
   closes (the PR says `Closes #N`). The next poll pass stops that worker; its
   transcript is retained.

If the user wants the work reopened later, reopen the issue - the next pass
resumes the exact same session that worked it.

## Setup / lifecycle

- First-time setup: `"$P" config-init` then edit `~/.config/agent-board/config.json`
  (`repos` = local repo paths, optional `gh_login`, `cap`, `poll_seconds`).
- Arm the scheduler: `"$P" install` (launchd on macOS, prints a cron line otherwise).
- Stop the scheduler: `"$P" uninstall`.

Never raise the concurrency cap blindly - many agents running heavy builds at
once can exhaust the host's memory. Raise it gradually and watch resource use.
