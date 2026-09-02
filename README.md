# Claude Code plugins

A personal [Claude Code](https://code.claude.com) plugin marketplace.

## Install

```
/plugin marketplace add <owner>/claude-plugins
/plugin install <plugin>@zamua
```

## Plugins

- **[agent-board](plugins/agent-board/)**: issue-board-driven orchestration of
  local Claude Code worker agents. Label an issue (sources: GitHub or Linear)
  and a local poller spawns a worker in a pane (runtimes: tmux or herdr) that
  works in a per-issue worktree and opens a draft PR; you review and merge.
- **[telegram](plugins/telegram/)**: multiplex ONE Telegram bot token across
  MANY concurrent agent conversations, routed by forum topics. Ordinary topics
  use foreground Claude Code with provider routing; fresh topics may instead be
  harness-locked to Google's official Antigravity CLI, with a separate dynamic
  model/effort picker and a persistent, drop-in-ready Herdr session that keeps
  the same Antigravity conversation across relaunches.
- **[reexplain](plugins/reexplain/)**: re-explain your last answer for a reader
  who is not a domain expert. Rebuilds the explanation instead of compressing it:
  diagnoses why the first attempt failed, defines each term on first use, keeps
  the codebase's own vocabulary, runs one concrete example the whole way through,
  and separates what is settled from what is broken from what nobody has decided.
- **[pr-review-board](plugins/pr-review-board/)**: react to a pull request with
  an emoji and a background Claude reviews it. A local poller spawns one review
  agent per changeset in its own herdr workspace, with a plain-English report
  live in nvim beside the agent, linked to the code it calls out. It ends by
  proposing a numbered list of comments and posts only the ones you pick. Never
  approves, never pushes.
- **[briefme](plugins/briefme/)**: a very short brief on where the current work
  stands. One paragraph on the state of things, then only the questions and
  decisions that need you, each saying who it is blocked on. For picking up a
  long session you have lost the thread of.

## License

MIT: see [LICENSE](LICENSE).
