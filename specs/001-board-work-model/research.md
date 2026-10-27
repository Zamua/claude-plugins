# Research: Board Work Model

Each decision below resolves an unknown from the plan's Technical Context. Facts marked
"checked" were observed on this machine on 2026-10-27; "to verify" ones are the first task of
the phase that needs them.

## R1. Reading the goal tracker (Rhythms)

- **Decision**: the board calls the Rhythms MCP tools itself, `mcp__rhythms__search_knowledge` with
  `goal_uuids` and `include_children`, through `$.tool.call`. A `tool.check` hook in the board
  allows exactly those read tools when `next.origin` is the board, so the call never prompts. The
  answer goes to a shared cache, refreshed at most hourly.
- **Rationale**: Rhythms has no CLI or public API key flow; its MCP server is connected at user
  scope (checked), and `$.tool.call` runs any tool the session has (checked in the API types).
  Goals change weekly, so an hourly window costs almost nothing.
- **To verify**: that `$.tool.call` of an MCP tool works from a `$.clock.every` callback outside a
  turn. Fallback: refresh only on `turn.start` and when the work view is shown.
- **Alternatives**: a separate sync agent writing a file (rejected: a second moving part,
  Constitution I); scraping the Rhythms app (rejected: brittle).

## R2. Reading the issue tracker (Linear)

- **Decision**: the `linear` CLI through `$.process.run`:
  `linear issue list --team <key> --project <name> --all-states --all-assignees --json`.
- **Rationale**: checked: it answers in about 0.4 s with id, identifier, title, url, state type and
  assignee, and it signs in as the person, so no permission prompt and no gateway service account.
- **Alternatives**: the Linear MCP connector (rejected: prompts unless allow-listed, and its token
  expires mid-task); the GraphQL API (rejected: needs a key the board would have to hold).

## R3. Pull requests as Artifacts

- **Decision**: no new GitHub calls. Artifacts come from what the board already knows: every
  session's prs board in the plugin store and the shared GitHub cache, whose facts include title
  and head branch.
- **Rationale**: Constitution IV; the GitHub budget is the one already exhausted once. Every pull
  request the person raised through a session is on some prs board.
- **Alternatives**: `gh search prs --author @me` (rejected for now: costs budget for a set the board
  mostly has).

## R4. Sessions: the herdr Host

- **Decision**: Sessions come through a Host port (data-model.md "Host and Harness"); herdr is its
  first adapter. It runs `herdr session list`, then `herdr --session <name> pane list` for each,
  keeping panes with an `agent`. A pane gives the workspace label, the agent kind, its session id
  (`agent_session.value`) and `agent_status` (idle, working, done; checked). Focusing runs
  `herdr --session <name> workspace focus <id>`, the same call `focusWorkspace` in `kit.tsx` makes
  today, which moves into the herdr Host.
- **Alternatives**: calling herdr from the core and the views (rejected: FR-022; a tmux or Zellij
  user would need core changes).
- **Rationale**: local and cheap; refreshed every 30 s only while the work view is shown.
- **To verify**: whether any herdr status means "waiting on the person". Until then a session shows
  herdr's own status word.

## R5. Time spent: the Claude Code Harness

- **Decision**: active time comes through a Harness port; Claude Code is its first adapter. A
  session's active time is read from its transcript,
  `~/.claude/projects/<cwd>/<session id>.jsonl`: the sum of the spans from each person's prompt to
  the last entry before the next prompt, with any gap over 5 minutes cut out. Results are cached
  per transcript by mtime.
- **Rationale**: herdr reports no durations (checked: no time field on a pane); the session record
  in `~/.claude/sessions/<pid>.json` has only `startedAt` and `statusUpdatedAt` (checked).
- **Alternatives**: wall time since start (rejected: counts idle days).

## R6. Matching Sessions and Artifacts to Items

- **Decision**: each Source gives its Items aliases, such as a Linear identifier `MM-809`. A
  Session's workspace label, an Artifact's title and branch are lowercased and searched for each
  alias as a whole token, bounded by anything not a letter or digit. The deepest matching Item
  wins; equally deep matches leave it unplaced. A hand link beats any match.
- **Rationale**: the identifiers are already there (`mm-809-crb-gross-funding`, `feature/mm-809`,
  `MM-809 adds …`); aliases keep tool-specific id formats inside the adapters (Constitution III).

## R7. Where the local file lives and who writes it

- **Decision**: the local Source is one JSON file, by default the work board's own
  `~/workspace/work-board/board.json`, rewritten in format version 2. Claude writes it through a
  new tool, `mcp__board__work`, which validates each change (no cycles, known parents) and writes
  by read, change, write.
- **Rationale**: agents in many sessions edit this file today by hand; a tool keeps the tree valid
  and lets the view redraw on change. The file stays in the person's own directory and git history.

## R8. Status mapping

- **Decision**: the core scale is the work board's own (needs you, in flight, waiting, next,
  watching, done), so migrated items keep their status as is. Adapters map into it:
  - Rhythms: `closed` done; `not_started` next; `postponed` waiting; others in flight; a goal the
    person owns with its weekly check-in unposted needs you.
  - Linear: state type `completed` or `canceled` done; `started` in flight, except a state named
    "In Review" waiting; `unstarted`, `backlog`, `triage` next.
  - Artifacts: the prs view's existing "needs you" rule.
  - Sessions: they carry the Host's state, mapped to working, waiting, idle or done, and do not roll
    up into Status.
- **Rationale**: one scale everywhere (spec FR-005); tool-specific words stay in the adapters.

## R9. Rollup order

- **Decision**: urgency order is needs you, in flight, waiting, next, watching, done. A parent's
  shown status is the first in that order among itself and its descendants, and it counts its
  descendants that need the person.
- **Rationale**: the order the work board already sorts by.
