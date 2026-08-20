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
  MANY concurrent Claude sessions, routed by forum topics. A local proxy owns
  the token + the single poll and spawns one foreground Claude (its own tmux
  session) per topic. A drop-in for the single-session telegram channel.
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

## License

MIT: see [LICENSE](LICENSE).
