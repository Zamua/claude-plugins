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

## License

MIT — see [LICENSE](LICENSE).
