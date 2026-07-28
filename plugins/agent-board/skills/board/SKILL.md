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
- **Run one poll pass now** (spawn newly labelled / resume stopped / reap unlabelled):
  `"$P" once`
- **Force-dispatch a specific issue** right now:
  `"$P" spawn <id>`
- **Stop an agent** (keeps its transcript; resume later):
  `"$P" reap <id>`
- **Resume a stopped agent** (e.g. after re-adding the label):
  `"$P" resume <id>`
- **Watch a worker live** / read its output:
  `claude attach <session-id>` (interactive) or `claude logs <session-id>`
- **See all background agents** (the native view): `claude agents`

## Creating work

The label is the whole trigger: a worker is dispatched when an issue is authored
by the configured user and carries the configured label (default `agent`), and is
reaped when the label comes off. Issue state is never consulted. To queue work:

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
3. When it's good and CI is green, **you** merge (`gh pr merge`). Merging does NOT
   end the worker - post-merge work like a release or an observability check is
   still its job. Stop it by removing the `agent` label; the next poll pass reaps
   it and its transcript is retained.

If the user wants the work picked back up later, re-add the label - the next pass
resumes the exact same session that worked it.

## Setup / lifecycle

- First-time setup: `"$P" config-init` then edit `~/.config/agent-board/config.json`
  (optional `gh_login`, `workdir`, `cap`, `poll_seconds`; no repo list - it
  watches all your repos via cross-repo search).
- Arm the scheduler: `"$P" install` (launchd on macOS, prints a cron line otherwise).
- Stop the scheduler: `"$P" uninstall`.

Never raise the concurrency cap blindly - many agents running heavy builds at
once can exhaust the host's memory. Raise it gradually and watch resource use.
