# Claude Code plugins

A personal [Claude Code](https://code.claude.com) plugin marketplace.

## Install

```
/plugin marketplace add <owner>/claude-plugins
/plugin install <plugin>@zamua
```

## Plugins

- **[telegram](plugins/telegram/)**: route one Telegram bot's forum topics to many concurrent agent conversations.
- **[pr-review-board](plugins/pr-review-board/)**: react to a pull request with an emoji and a background Claude reviews it, posting only the comments you pick.
- **[board](plugins/board/)**: one pane beside the chat that holds every board, with a button per board showing how many items wait on you.
- **[code-review](plugins/code-review/)**: review code from ownership and approach down to the fourteen clean-code smells.
- **[clean-copy](plugins/clean-copy/)**: cut interface copy that shouldn't exist, adapted from a skill by Rachel ([@chaotictransfem](https://x.com/chaotictransfem)).

## Herdr mods

Panels for the [Herdr app](https://herdr.dev), in [herdr-mods/](herdr-mods/).
`herdr-mods/install.sh` hard-links each mod into `~/.config/herdr-app/mods/` and
links the layouts; Herdr refuses symlinked mod code and serves no icons through a
symlinked folder. Run it again after a pull.

- **[session-tree](herdr-mods/session-tree/)**: a sidebar tree of Claude sessions, root first, with one glyph per row for its status.
- **[session-prs](herdr-mods/session-prs/)**: tabs listing every session's pull requests, reviews, open asks and tracker files.
- **[work-graph](herdr-mods/work-graph/)**: a read-only, zoomable graph of all tracked work and what blocks what.
- **[tree layout](herdr-mods/layouts/tree.json)**: Herdr's main layout with the session tree as its sidebar and the PRs pane beside the terminals.
- **[quiet-toast](herdr-mods/quiet-toast/)**: drops Herdr's "an agent finished" toasts and keeps the rest.

## License

MIT: see [LICENSE](LICENSE).
