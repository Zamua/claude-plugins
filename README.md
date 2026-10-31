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

- **[pr-review-board](plugins/pr-review-board/)**: react to a pull request with
  an emoji and a background Claude reviews it. A local poller spawns one review
  agent per changeset in its own herdr workspace, which writes a plain-English
  report linked to the code it calls out. It ends by
  proposing a numbered list of comments and posts only the ones you pick.
  Approves only when you say so, never pushes. Its board draws in the
  [board](plugins/board/) pane.

- **[board](plugins/board/)**: one pane beside the chat holding every board,
  with a row of buttons to switch between them, each showing how many items wait
  on you. The session board Claude keeps current, the pull requests this session
  raised with GitHub's live state, the pr-review-board review this session runs,
  one tree of everything you work on from your goals down to the sessions and
  pull requests doing it, where a root session starts and coordinates the
  others, and any board another process writes as JSON, such as a rollout, named
  in `~/.config/board/boards.json`. `/board` toggles the pane, `/board <name>` opens
  it on one board, `/board <name> clear` empties one.
- **[clean-code-audit](plugins/clean-code-audit/)**: nine structural smells
  that make code hard to change safely, from implicit coupling and illegal states
  to validation that happens deep inside instead of at the boundary. Use it as a
  set of questions while designing a change, as a checklist when self-reviewing a
  diff, or to audit a whole repo with path:line evidence and every fix it calls for.

## License

MIT: see [LICENSE](LICENSE).
