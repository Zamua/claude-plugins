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
- **[clean-code-audit](plugins/clean-code-audit/)**: thirteen smells that make code
  hard to change safely or slow on its hot paths, from implicit coupling and illegal
  states to validation deep inside instead of at the boundary, tests that pin the
  implementation, lifecycles that live only in scattered flags, independent awaits
  run one after another, and whole rows loaded for a few fields. Use it as a
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
  is done, a red hand has open asks, a red ! waits on a dialog. It keeps Herdr's
  space order in the tree's order. Cmd+W and Cmd+Shift+W ask before closing a tab
  or pane that holds a live Claude session, a closed root gets a Reopen row that
  resumes it, and `session-tree.new` opens a dialog that starts a session.
- **[session-prs](herdr-mods/session-prs/)**: tabs over the sessions' state files,
  plus one per tracker file. PRs: every session's pull requests, one dense row each, in sections by each
  entry's `group` inside its project, with draft, CI, your approval, author and
  stacks from one GitHub query a minute while it shows; finished workstreams fold
  into Done, closed PRs drop off, and headers stay pinned while it scrolls. With
  `{"authored": {"owners": [..]}}` in `~/.config/herdr-app/session-prs.json` it also
  lists every open PR you authored under those owners, from the same query's search;
  one no session lists goes where the root's `pr-groups.json` places it, under a
  project and section or a named workstream, else under Untracked at the top. Reviews:
  the reviews project's PRs the same way, a section per review session. Asks: every
  open ask by project, due soonest first, each with a short id (A1 and up) it keeps
  for good in the root's `ask-ids.json`; a row opens a dialog that numbers the ask's
  options, so you can name one in chat, such as "A25 option 2". Trackers: each JSON
  file listed in `~/.config/herdr-app/session-prs.json` as `{"trackers": [path]}`
  gets a read-only tab named by its `title`: the count by status, every gap up top,
  then each section with its items' status, owner, note or what they wait on, and
  per-environment values; a row opens the item's detail and links.
- **[work-graph](herdr-mods/work-graph/)**: a read-only DAG of all tracked work that
  zooms, for a pane or tab of its own. Each open project is a lane, and inside it the
  nodes of the project's `graph.json` nest by `parent`: steps, then issues, then PRs and
  small tasks. A collapsed node is one card that rolls up what it holds ("1 needs you,
  3 in flight, 2 blocked"); an expanded one is a frame around its children. Arrows run
  from each blocker to what it blocks, combined into one thicker arrow between collapsed cards,
  in columns by dependency depth. A leaf is done, needs you (an open ask names it), in
  flight (its owner session is working), waiting (its owner has a background job or a wake
  pending), blocked, owned but idle, or ready to start now, and the header
  lists what can start now. Level buttons, or `work-graph.level0` to `level3`, expand
  everything to a depth, clicking a card opens or closes one node, and Cmd with scroll zooms
  around the pointer; the change animates,
  a card growing into its frame as its children come out of it, the opened node held in place. Linear issues
  (through the `linear` CLI) bring their state, sub-issues, `blocks` relations and PR
  links, and GitHub brings PR state and stacks by base branch; a project with no graph
  file is one card from its state file. The graph file is
  `<projects>/<project>/graph.json`, or the coordinator's `graph` field, as
  `{"nodes": [{id, title, kind, summary, parent, blockedBy, status, owner, asks, note, link, pr}]}`,
  plus `links: [{label, url}]`, where a card shows only `title` (a word or two), `kind` (one
  word) and `summary` (five to seven words), and its status as an icon and colour. Resting the
  pointer on a card fades everything not on its path, what it waits on and what waits on
  it across projects. Its i icon opens a popup with the rest and a labelled link to its issue, PR, stack
  neighbours, extra links and owner session's pane; a file opens in the mod's own read-only
  viewer, never an editor.
  Open it with `herdr-app do tab.new --mod work-graph`, with the projects folder in
  `~/.config/herdr-app/work-graph.json` as `{"folder": "~/projects"}`.
- **[tree layout](herdr-mods/layouts/tree.json)**: Herdr's main layout with the
  session tree as its sidebar and the PRs pane beside the terminals, toggled with
  Cmd+Shift+R once `keys.json` binds it.
- **[quiet-toast](herdr-mods/quiet-toast/)**: drops Herdr's "an agent finished"
  toasts and keeps the rest, by patching Herdr's own toast mod, since no setting
  picks which toasts show. Herdr restores its mod on every start; `apply.sh --agent`
  adds a launchd agent that patches it again each time, and `--undo` reverses either.

## License

MIT: see [LICENSE](LICENSE).
