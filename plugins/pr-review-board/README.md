# pr-review-board

React to a pull request with 👀 and a background Claude reviews it.

A local poller watches GitHub for reactions **you** added in the last few minutes,
then spawns one review agent per changeset in its own herdr tab. The agent
writes the whole review to a board, drawn beside it in the review view of the
[board](../board/) plugin's pane: a
plain-English report linked to every pull request and every line it calls out, and
the numbered comments it proposes. It posts only the ones you pick, and approves a
pull request only when you tell it to.

```
you add 👀 to a PR        ─▶  poller sees it (1 GraphQL call, cost 1)
                                  │
                                  ├─ new herdr tab, one review agent
                                  ├─ clones + worktrees the PR head
                                  ├─ reviews it, proves bugs with failing tests
                                  ├─ writes its board as it goes, shown in /board review
                                  └─ proposes numbered comments, then waits
PR gets new commits       ─▶  the agent re-reads the diff and revises everything
you ask it questions      ─▶  it answers in its pane
you tick 1 and 3, send    ─▶  it posts those two, signed off, and nothing else
you say to approve        ─▶  it approves that pull request and no other
you run /pr-review-board:cleanup  ─▶  everything torn down, no confirmation
```

## Why reactions

The trigger lives on the thing being reviewed, there is no channel to scope or token
to mint, and `gh` is already authenticated. Only **your** reaction counts, which
matters because bots react to pull requests constantly.

## Install

```
/plugin marketplace add Zamua/claude-plugins
/plugin install pr-review-board@zamua
```

Or develop locally: `claude --plugin-dir /path/to/pr-review-board`.

Requires `gh` (authenticated), `herdr`, `jq`, `git`, and a Bash shell.
macOS uses launchd; other platforms use cron.

## Configure

```
"${CLAUDE_PLUGIN_ROOT}/scripts/poll.sh" config-init
```

Then edit `~/.config/pr-review-board/config.json`. `orgs` is the only key you must
set:

| key | default | meaning |
| --- | --- | --- |
| `orgs` | `[]` | **required.** GitHub orgs to watch, e.g. `["my-org","my-user"]`; a pull request outside them is never seen, and an empty list refuses to scan rather than searching all of GitHub |
| `reaction` | `EYES` | the trigger emoji, as a GraphQL `ReactionContent` value |
| `spawn_window_seconds` | `600` | floor on how recent a reaction must be to spawn |
| `search_extra` | `""` | extra search qualifiers, e.g. `is:open` to ignore merged pull requests |
| `cap` | `3` | max concurrent reviews |
| `poll_seconds` | `90` | scheduler interval |
| `reviews_root` | `~/workspace/reviews` | where review directories live |
| `workspace_root` | `~/workspace` | where canonical clones live |
| `herdr_session` | `reviews` | the shared herdr session reviews run in; created on demand |
| `herdr_workspace` | `""` | a workspace label every review opens a tab in, made the first time; empty gives each review a workspace of its own |
| `source` | `github-reactions` | the trigger adapter, `scripts/adapters/source-<name>.sh` |
| `runtime` | `herdr` | `stub` records what would happen and launches nothing |
| `agent_kind` | `claude` | the herdr agent kind, which also names the executable |
| `agent_cmd` | `["claude"]` | the worker's argv; the first element is ignored in favour of `agent_kind`, the rest are passed through |
| `worker_subagent` | `pr-reviewer` | passed as `--agent`; empty runs the worker without a persona |
| `plugin_dir` | `""` | passed as `--plugin-dir` when set, to run workers against a local checkout |
| `gh_login` | `""` | whose reactions count; empty means the login `gh` is authenticated as |
| `issue_key_pattern` | `[a-z]{2,4}-[0-9]+` | tracker id in a branch, used to group cross-repo pull requests |
| `permission_mode` | `""` | passed as `--permission-mode` when set; empty means inherit yours |
| `dangerously_skip` | `false` | add `--dangerously-skip-permissions` |
| `house_rules` | `""` | extra text handed to every worker |

> **Permissions.** A background worker cannot answer a permission prompt, so leave
> `permission_mode` empty and let it inherit yours. Two traps:
>
> - **Do not reach for `bypassPermissions` or `dangerously_skip`.** Both are gated
>   behind a one-time interactive "I accept" screen that a background agent cannot
>   clear: it exits after a few seconds and the review never starts.
> - **Setting `permission_mode: "acceptEdits"` is worse than setting nothing**, since
>   it is more restrictive than a default `auto` mode for reads outside the cwd.
>
> The agent's cwd is `reviews_root`, so its assignment, its rules copy and every
> checkout are all inside one directory and nothing it needs sits outside it. That,
> not a permission flag, is what makes unattended review work.

## Run it

```
poll.sh fresh         what the trigger sees right now, without acting
poll.sh once          one pass
poll.sh status        every review and its state
poll.sh spawn <pr>    force one pull request in, ignoring the freshness window
poll.sh install       arm the scheduler
poll.sh uninstall     disarm it
```

Validate a new config with `"runtime": "stub"` and `poll.sh once`: it exercises the
trigger, the grouping and the assignment file without launching an agent.

## Tests

```
tests/run.sh                  # against ../scripts
SCRIPTS=<path> tests/run.sh   # against another checkout
```

Every case proves a defect that once shipped, so each one failed before its fix. They
build their own config, state and reviews root under `mktemp` and use the stub runtime,
so nothing touches real state and no agent is launched. Some cases call the GitHub API,
so an authenticated `gh` is required.

## The board

Everything a review produces lives in one file, `board.json` in the review's
metadata directory. The [board](../board/) plugin draws it in its pane's review view,
which opens by itself in the review's session and `/board review` opens anywhere:

- the verdict, the risk and the blast radius, one sentence each
- one button per stack beside All, each stack heading with its own verdict, risk and
  blast radius and listing its pull requests as the board's prs view lists them:
  linked, with their git stack, approval, CI, state and author, and a warning mark
  beside each one with a thread waiting on you. The board reads those from GitHub
  through the cache its prs view shares, so a pull request both show is asked
  about once
- the proposed comments by severity, each marked `new`, `carried over` or `not a
  bug`, linked to its code and the scratch test that proves it, and opening in place
  to the exact text it would post and the finding behind it
- the report, one closed section per heading
- the comments already posted, split into Unaddressed and Addressed, so a stack
  with no open threads is easy to spot

Tick comments and press Draft to put `post 1, 3` in the prompt box. Sending it is
yours. The agent posts from the board itself, through `scripts/board.sh`, so what
goes to GitHub is the wording you read, and a comment already posted is refused.
A review run by hand through the skill keys its board by the session's id, so the
pane finds it the same way. So does a board any session writes there to track pull
requests it is not reviewing, such as the ones it commented on; the poller refreshes
its GitHub facts every ten minutes.

## Skills

| | |
| --- | --- |
| `/pr-review-board:review <url>` | review a pull request by hand, same rules, no poller |
| `/pr-review-board:cleanup` | tear a finished review down |

## The freshness window

A reaction spawns a review only if it was added within
`max(spawn_window_seconds, time since the last successful poll)`.

The floor means an old 👀 never wakes up a review. The widening means a laptop that
slept through a reaction still catches it, instead of dropping it silently. A failed
scan does not advance the watermark, so a GitHub outage delays reviews rather than
losing them.

## Grouping

One reaction is one review. Two pull requests join the same review when either holds:

- **Chain.** One's base branch is the other's head branch. That is a stack, and it is
  authoritative.
- **Tracker id.** Their branches carry the same id, e.g. `feature/abc-123` in two
  repos.

That only decides which reactions share a review. What a review covers is the
agent's call. A pull request in a stack always brings the whole stack: the agent
lists every open layer with `poll.sh stack` and adds the ones you did not react to
with `poll.sh adopt`, so reacting to any one layer reviews them all. It may adopt
other pull requests the change cannot be judged without. A pull request another live
review covers stays there.

A review that grows past one pull request is promoted to an umbrella directory named
after the pull request that opened it, so the name never depends on arrival order.
The agent states in its report which pull requests it grouped, which it added, and
why.

## Cleanup

Manual only, via the skill, and it runs as soon as you ask, with no confirmation.
Removing the reaction does nothing. `CLEANEDUP` is terminal: the poller never
resurrects a torn-down review. Re-reviewing the same pull request takes a genuinely
new reaction, which opens a fresh review.

Nothing is kept. The board and any scratch tests go with the review, so the comments
posted on GitHub are the lasting record.

## License

MIT.
