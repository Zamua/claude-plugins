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

## License

MIT: see [LICENSE](LICENSE).
