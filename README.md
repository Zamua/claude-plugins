# Claude Code plugins

A personal [Claude Code](https://code.claude.com) plugin marketplace.

## Install

```
/plugin marketplace add <owner>/claude-plugins
/plugin install <plugin>@zamua
```

## Plugins

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
  others and sees every ask waiting on you and every session's pull requests
  and reviews in a tab per section, and any board another process writes as JSON, such as a rollout, named
  in `~/.config/board/boards.json`. `/board` toggles the pane, `/board <name>` opens
  it on one board, `/board <name> clear` empties one.
- **[clean-code-audit](plugins/clean-code-audit/)**: eleven smells that make code
  hard to change safely, from implicit coupling and illegal states to validation
  deep inside instead of at the boundary, tests that pin the implementation, and
  lifecycles that live only in scattered flags
  instead of the behaviour. Use it as a
  set of questions while designing a change, as a checklist when self-reviewing a
  diff, or to audit a whole repo with path:line evidence and every fix it calls for.

## Herdr mods

Panels for the [Herdr app](https://herdr.dev), in [herdr-mods/](herdr-mods/).
`herdr-mods/install.sh` hard-links each mod into `~/.config/herdr-app/mods/` and
links the layouts; Herdr refuses symlinked mod code and serves no icons through a
symlinked folder. Run it again after a pull.

- **[session-tree](herdr-mods/session-tree/)**: a sidebar of a tree of Claude
  sessions, root first, then each project's coordinator with its workers under it,
  from the terminals' `tree.role`, `tree.project` and `tree.parent` labels and each
  session's state file. One glyph per row says its status: a spinner works, a dot
  is done, a red hand has open asks, a red ! waits on a dialog. Cmd+W and
  Cmd+Shift+W ask before closing a tab or pane that holds a live Claude session,
  and a closed root gets a Reopen row that resumes it.
- **[session-prs](herdr-mods/session-prs/)**: every session's pull requests, one
  dense row each, in sections by each entry's `group` inside its project, with
  draft, CI, review, author and stack ("on #N") from one GitHub query a minute
  while it shows.
- **[tree layout](herdr-mods/layouts/tree.json)**: Herdr's main layout with the
  session tree as its sidebar and the PRs pane beside the terminals, toggled with
  Cmd+Shift+R once `keys.json` binds it.
- **[quiet-toast](herdr-mods/quiet-toast/)**: drops Herdr's "an agent finished"
  toasts and keeps the rest, by patching Herdr's own toast mod, since no setting
  picks which toasts show. Herdr restores its mod on every start; `apply.sh --agent`
  adds a launchd agent that patches it again each time, and `--undo` reverses either.

## License

MIT: see [LICENSE](LICENSE).
