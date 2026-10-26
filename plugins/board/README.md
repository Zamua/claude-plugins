# board

One pane beside the chat holding every board. A row of buttons across the top
switches between them, and each button shows how many items on its board wait on
you.

```
 session 1 · prs · review 3 │ work 2 · oncall
╭──────────────────────────────────────────╮
│ the board you picked                     │
╰──────────────────────────────────────────╯
```

| Board | What it shows | Filled by |
| --- | --- | --- |
| `session` | the goal, where things stand, next steps, open questions, decisions, links, ideas and topics | Claude, through `mcp__board__session` |
| `prs` | the pull requests this session raised, each stack bottom first, with GitHub's live state | Claude, through `mcp__board__prs`; `gh pr create` and `gh stack submit` add theirs on their own |
| `review` | the [pr-review-board](../pr-review-board/) review this session runs | the review agent's `board.json` |
| any name | a board another process writes as JSON | the file named in the config below |

The prs board shares what it fetches from GitHub with every session through `~/.cache/board/github.json`, so a pull
request is asked about at most once every three minutes however many sessions track it, and a merged one never again.
A session asks only while someone has used it in the last half hour. Below 1000 GraphQL points left in the hour, or
after a rate limit error, every session stops asking until the limit resets.

This session's boards come first, and a thin `│` parts them from the boards every session shares. A board shows in
the row once it has something to show. Each session keeps its own
session and prs boards, restored on resume.

## Commands

| | |
| --- | --- |
| `/board` | show or hide the pane |
| `/board <name>` | open the pane on one board, by name or a unique prefix; again closes it |
| `/board <name> clear` | empty the session or prs board; bare `/board clear` empties the one on show |

The pane opens by itself when Claude first writes to the session or prs board, and
at the start of a session that runs a review or resumes with a board. Once you close
it, it stays closed until you open it again.

## Boards from files

`~/.config/board/boards.json` names the boards other processes write. `BOARD_CONFIG`
points at another file.

```json
{
  "boards": [
    { "id": "work", "path": "~/boards/work.json", "layout": "groups" },
    {
      "id": "oncall",
      "path": "~/boards/oncall.json",
      "layout": "sections",
      "stale_minutes": 12,
      "stale_text": "The monitor may be stuck.",
      "titles": { "done": "Done today" }
    }
  ],
  "link_labels": { "dashboard.example.com": "Dashboard" },
  "link_pairs": [
    { "first": "https://dash.example.com/loan/", "second": "https://dash.example.com/contract/", "label": "contract" }
  ]
}
```

- `layout`: `sections` draws one colored box per status. `groups` draws one box per
  project, nesting workstreams by `parent`, with a status tag on each item.
- `stale_minutes`: a board not updated for this long says so in red.
- `titles`: section titles by status, over the defaults.
- `link_labels`: short names for links by host, over the built-in ones for Slack,
  Linear, GitHub, Notion, Grafana, Statsig and Rootly.
- `link_pairs`: a link to `first<id>` followed by one to `second<id>` share a line.

The board file itself:

```json
{
  "updated_at": "2026-10-16T13:55:00Z",
  "groups": [{ "id": "pay", "title": "Payments", "parent": "optional", "source": "url", "links": [] }],
  "items": [
    {
      "id": "a1",
      "ref": 1,
      "group": "pay",
      "section": "needs",
      "title": "Answer the vendor",
      "workspace": "herdr-label",
      "source": "url",
      "links": [{ "label": "optional", "url": "url" }],
      "due": "2026-10-17T00:00:00Z",
      "due_label": "SLA"
    }
  ]
}
```

`section` is one of `needs`, `flight`, `next`, `waiting`, `watching` and `done`.
Pressing a title with a `workspace` raises that herdr workspace, and the lines under
it open their links. The view re-reads the file every 15 seconds.

## Tests

`claude plugin test .`
