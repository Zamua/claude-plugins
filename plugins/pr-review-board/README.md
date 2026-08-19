# pr-review-board

React to a pull request with 👀 and a background Claude reviews it.

A local poller watches GitHub for reactions **you** added in the last few minutes,
then spawns one read-only review agent per changeset in its own herdr workspace. Each
pull request gets a live hunkt diff you can read, annotated inline, plus a report
written in plain English. Nothing is ever posted to GitHub.

```
you add 👀 to a PR        ─▶  poller sees it (1 GraphQL call, cost 1)
                                  │
                                  ├─ new herdr workspace, one review agent
                                  ├─ clones + worktrees the PR head
                                  ├─ one tab per PR: a watched hunkt diff
                                  ├─ reviews it, proves bugs with failing tests
                                  └─ annotates the diff + writes REVIEW.md
PR gets new commits       ─▶  the agent re-syncs the diff and revises everything
you ask it questions      ─▶  it answers in its pane
you run /pr-review-board:cleanup  ─▶  archived report, everything else torn down
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

Requires `gh` (authenticated), `herdr`, `hunkt`, `jq`, `git`, and a Bash shell.
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
| `runtime` | `herdr` | `stub` records what would happen and launches nothing |
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
poll.sh status        the board
poll.sh spawn <pr>    force one pull request in, ignoring the freshness window
poll.sh install       arm the scheduler
poll.sh uninstall     disarm it
```

Validate a new config with `"runtime": "stub"` and `poll.sh once`: it exercises the
trigger, the grouping and the assignment file without launching an agent.

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

A review that grows past one pull request is promoted to an umbrella directory named
after the pull request that opened it, so the name never depends on arrival order.
The agent states in its report which pull requests it grouped and why.

## Cleanup

Manual only, via the skill. Removing the reaction does nothing. `CLEANEDUP` is
terminal: the poller never resurrects a torn-down review. Re-reviewing the same pull
request takes a genuinely new reaction, which opens a fresh review beside the kept
record.

`REVIEW.md` is archived to `<reviews_root>/.archive/<slug>.md` before the directory
goes.

## License

MIT.
