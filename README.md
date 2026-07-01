# Claude Code plugins

A personal [Claude Code](https://code.claude.com) plugin marketplace.

## Install

```
/plugin marketplace add <owner>/claude-plugins
/plugin install <plugin>@zamua
```

## Plugins

- **[agent-board](plugins/agent-board/)** — turn your GitHub issues into a board
  of background Claude Code agents. A local poller dispatches your labelled
  issues to background workers (one git worktree each) that do the work, comment
  progress, and open PRs; you review and merge.
- **[telegram](plugins/telegram/)** — multiplex ONE Telegram bot token across
  MANY concurrent Claude sessions, routed by forum topics. A local proxy owns
  the token + the single poll and spawns one foreground Claude (its own tmux
  session) per topic. A drop-in for the single-session telegram channel.

## License

MIT — see [LICENSE](LICENSE).
