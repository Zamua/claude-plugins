# board

One pane beside the chat holding every board. A row of buttons across the top
switches between them, and each button shows how many items on its board wait on
you.

```
 session 1 · prs · review 3 │ work 2 · rollout 4 · oncall
╭──────────────────────────────────────────╮
│ the board you picked                     │
╰──────────────────────────────────────────╯
```

| Board | What it shows | Filled by |
| --- | --- | --- |
| `session` | the goal, where things stand, next steps, open questions, decisions, links, ideas and topics | Claude, through `mcp__board__session` |
| `prs` | the pull requests this session raised, each stack bottom first, with GitHub's live state | Claude, through `mcp__board__prs`; `gh pr create` and `gh stack submit` add theirs on their own |
| `review` | the [pr-review-board](../pr-review-board/) review this session runs | the review agent's `board.json` |
| `work` | everything you work on as one tree, from your goals down to the sessions and pull requests doing it | Claude, through `mcp__board__work`, plus the trackers it reads |
| `rollout` | a release's prerequisites, gates and checks, with each one's state per environment | a JSON file another process keeps |
| any name | a board another process writes as JSON | the file named in the config below |

This session's boards come first, and a thin `│` parts them from the boards every session shares. A board shows in
the row once it has something to show. Each session keeps its own session and prs boards, restored on resume.

The prs board shares what it fetches from GitHub with every session through `~/.cache/board/github.json`, so a pull
request is asked about at most once every three minutes however many sessions track it, and a merged one never again.
A session asks only while someone has used it in the last half hour. Below 1000 GraphQL points left in the hour, or
after a rate limit error, every session stops asking until the limit resets. A pull request's CI goes by the latest
run of each check, as GitHub's checks list shows it. The Author and Repo boxes above the list narrow it to the ticked
values.

## Commands

| | |
| --- | --- |
| `/board` | show or hide the pane |
| `/board <name>` | open the pane on one board, by name or a unique prefix; again closes it |
| `/board <name> clear` | empty the session or prs board; bare `/board clear` empties the one on show |
| `/board <name> png` | save the board as a picture on the Desktop, at the pane's width and its full height, and copy it; needs Google Chrome |
| `/board work <period>` | cut the work view to a Period from its config, by name; `all` shows every Item again |
| `/board work migrate` | rewrite a work board from the old groups format; the old file stays beside it as `board.v1.json` |

The pane opens by itself when Claude first writes to the session or prs board, and
at the start of a session that runs a review or resumes with a board. Once you close
it, it stays closed until you open it again.

## The work view

One tree of Items, from your goals down to tasks. An Item either ends, an Outcome such as a project or a task, or
never does, a Responsibility such as on-call or code review. Outcomes come first, Responsibilities after them, and
the Unplaced sessions and pull requests last.

```
[ Period: all ▾ ]                              Updated 2m ago
Outcomes
▸ you   1 Fri 10-31 Objective 40% Grow funding partners   12h
▸ next  Project Thread release notes                     2h ●
Responsibilities
▸ now   Responsibility On-call                           5h ●
Inbox
· next  Task Answer the vendor                     from Hasan
▸ Unplaced 3 sessions · 1 pull request
```

- **Kinds** are your own names for each level, such as Objective, Key result, Project and Task, or Thesis, Chapter
  and Experiment. The core names none of them.
- **Status** is one scale for everything: needs you, in flight, waiting, next, watching, done. A folded Item counts
  what needs you beneath it, so one deep in the tree shows at the top.
- **Sessions** sit under the Item they serve, with their state on the right: waiting on you, working, idle or done.
  Pressing one brings its herdr workspace to the front. A session attaches by itself when its workspace label carries
  an Item's id or alias, such as `mm-809-crb-gross-funding` for MM-809; Claude links the rest by hand.
- **Pull requests** from every session's prs board sit under the Item whose id or alias their title or branch
  carries, such as `MM-809 adds …` or `feature/mm-809`.
- **Dates**: a target date shows on its line, yellow inside a day and red inside two hours or once past.
- **Time** on the right of a line is the active time of every session under it, finished ones included: a session's
  transcript from first entry to last, with every gap over five minutes cut out.
- **Periods**, such as quarters, cut the view to the Items dated in one, the undated work under them and their
  ancestors. Responsibilities and the Inbox show in every Period. Pick one in the Period box or with
  `/board work <period>`.
- **Inbox**: an ask with no parent waits here, with who asked, until it is placed under an Item.
- Pressing an Item opens its children, its detail and its links. The view re-reads its file every 15 seconds, and
  lists sessions only while someone looks at it.

### Sources

Each Source is read through one adapter and cached in `~/.cache/board/` for every session to share.

| Source | Items it gives | Fresh for |
| --- | --- | --- |
| the local file | Responsibilities, side projects, anything kept by hand, and the links no other Source holds | re-read every 15 seconds |
| `rhythms` | the goals you follow and their children, with progress, the latest check-in and their start and end dates; a goal you own that is overdue for a check-in needs you | an hour, asked when the view opens or Claude reads the tree |
| `linear` | each project you follow and its issues, through the `linear` CLI | ten minutes |
| `github` | the pull requests on every session's prs board | the prs board's three minutes |
| `boards` | another board's items, under an Item of yours; its archive stays off | re-read every 15 seconds |

Only local Items can be added, changed or removed. Any Item, session or pull request can be linked under another, and
a hand link wins over the parent its Source gives.

### Sessions, the root and coordinators

`mcp__board__work` is the work tool. With no fields it reads the tree, each session listed under its Item with its
state, the name to message it by, and the goal and summary from its session board. Its fields:

- `add`, `update`, `remove`: local Items. Mark finished work `done` rather than removing it.
- `link`, `unlink`: a hand-set parent for any Item, session or pull request. A session's parent can be another session,
  its Coordinator; a session keeps one Item parent and one Coordinator.
- `attach`: put this session under an Item.
- `start`: start a session for an Item with a brief, as this session's child. It opens a herdr workspace named after
  the Item, starts the harness in it and sends the brief as the first prompt. It is refused when the Item already has
  a running session, unless `again`.
- `root`: make this session the root, the one you talk to. Every breadcrumb and work view then starts with a `⌂` mark
  that brings it to the front.
- `aliases`: identifiers a workspace label, pull request title or branch may carry, such as an issue key.

The session view starts with where its session sits, such as `⌂ root  Grow funding partners › MM-809  ↗`. The `⌂`
mark brings the root session to the front, and `↗` opens the work view down to this session. The [`root` skill](skills/root/SKILL.md) tells a root or coordinator
session how to answer status questions from one tree read, start sessions with a complete brief, and message
coordinators rather than their workers.

### Config

The `work` entry in `~/.config/board/boards.json` takes `layout: "model"`:

```json
{
  "id": "work",
  "layout": "model",
  "path": "~/workspace/work-board/board.json",
  "sources": {
    "rhythms": { "follow": ["OBJ-2228"], "kinds": { "objective": "Objective", "key_result": "Key result" } },
    "linear": {
      "team": "MM",
      "projects": [{ "name": "CRB Funding - Money Movement", "under": "rhythms:KR-6204" }],
      "kinds": { "project": "Project", "issue": "Task" }
    },
    "github": {},
    "boards": { "oncall": "on-call" }
  },
  "hosts": { "herdr": { "cwd": "~" } },
  "harnesses": { "claude": { "args": ["--model", "opus[1m]"] } },
  "periods": [{ "name": "Q4 2026-27", "start": "2026-11-01", "end": "2027-01-31" }]
}
```

A Source left out of `sources` is off; with none, the view runs on the local file alone. `under` places a Source's
Item under one of yours, by id. `hosts` says where started sessions run and from which directory, and `harnesses`
which agent starts in them and with what arguments. `periods` are named date ranges, the end date included. A key
nothing reads draws one warning line in the view.

The local file:

```json
{
  "version": 2,
  "items": [
    { "id": "on-call", "title": "On-call", "kind": "Responsibility", "shape": "responsibility", "status": "flight" },
    { "id": "thesis", "title": "Thesis", "kind": "Thesis", "status": "flight", "aliases": ["th"] },
    { "id": "ch2", "ref": 2, "title": "Related work", "kind": "Chapter", "parent": "thesis", "status": "needs",
      "target": "2026-11-15", "links": [{ "label": "draft", "url": "https://example.com/ch2" }] }
  ],
  "links": [{ "child": "session:herdr:default/w9", "parent": "ch2" }]
}
```

An Item also takes `detail`, markdown shown when it is pressed open, `origin`, why it exists: `planned`, `asked`
with `by`, `interrupt` or `self`, and `started` and `finished` dates, which the tool stamps when an Item first moves
off `next` and when it is marked `done`. Unknown fields are kept when the tool rewrites the file. A file still in the old
format, `groups` plus `items` with a `section`, says to run `/board work migrate`, which turns groups into Projects
and items into Tasks under them.

## Boards from files

`~/.config/board/boards.json` names the boards other processes write. `BOARD_CONFIG`
points at another file.

```json
{
  "boards": [
    {
      "id": "oncall",
      "path": "~/boards/oncall.json",
      "stale_minutes": 12,
      "stale_text": "The monitor may be stuck.",
      "titles": { "done": "Done today" }
    },
    { "id": "rollout", "path": "~/boards/rollout.json", "layout": "rollout" }
  ],
  "link_labels": { "dashboard.example.com": "Dashboard" },
  "link_pairs": [
    { "first": "https://dash.example.com/loan/", "second": "https://dash.example.com/contract/", "label": "contract" }
  ]
}
```

- `layout`: left out, a board draws one colored box per status. `rollout` draws a rollout, below; `model` is the
  work view.
- `stale_minutes`: a board not updated for this long says so in red.
- `titles`: section titles by status, over the defaults.
- `link_labels`: short names for links by host, over the built-in ones for Slack,
  Linear, GitHub, Notion, Grafana, Statsig and Rootly.
- `link_pairs`: a link to `first<id>` followed by one to `second<id>` share a line.

The board file itself:

```json
{
  "updated_at": "2026-10-16T13:55:00Z",
  "items": [
    {
      "id": "a1",
      "ref": 1,
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

### Rollouts

A rollout board folds each section to its title and counts, showing only its gaps and blocked items until pressed
open. Each item draws its status, title, what it waits on and owner, with its state in each environment at the
right edge. Pressing an item shows its owner, note, detail and links, and `work` jumps to an Item in the work view.

```json
{
  "updated_at": "2026-10-27T17:50:00Z",
  "title": "CRB rollout",
  "envs": ["staging", "prod"],
  "sections": [
    {
      "id": "gates",
      "title": "Gates, in flip order",
      "items": [
        {
          "id": "g-crb",
          "title": "release.loan_service.crb_funding",
          "status": "todo",
          "owner": "Zamua",
          "note": "Umbrella flag",
          "env": { "staging": "on", "prod": "off" },
          "after": ["g-routing"],
          "detail": "markdown",
          "links": [{ "label": "Gate", "url": "url" }],
          "work": "file:crb"
        }
      ]
    }
  ]
}
```

`status` is one of `gap`, `blocked`, `doing`, `ready`, `todo`, `watching` and `done`. The rollout's button counts its
gaps.

## Tests

`claude plugin test .`
