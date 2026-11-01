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
| `decisions` | in the root session, every ask waiting on you, with its options and a recommendation | any session, through `mcp__board__work` |
| `all prs` | in the root session, every session's pull requests, a tab per work-view section | the work tree and every session's prs board |
| `all reviews` | in the root session, every pr-review-board review and where it stands, a tab per work-view section | the work tree and pr-review-board's own files |
| `rollout` | a release's prerequisites, gates and checks, with each one's state per environment | a JSON file another process keeps |
| any name | a board another process writes as JSON | the file named in the config below |

This session's boards come first, and a thin `│` parts them from the boards every session shares. A board shows in
the row once it has something to show. Each session keeps its own session and prs boards, restored on resume.

The prs board shares what it fetches from GitHub with every session through `~/.cache/board/github.json`, so a pull
request is asked about at most once every three minutes however many sessions track it, and a merged one never again.
A session asks only while someone has used it in the last half hour. Below 1000 GraphQL points left in the hour, or
after a rate limit error, every session stops asking until the limit resets. A pull request's CI goes by the latest
run of each workflow and each check, as GitHub's checks list shows it. The Author and Repo boxes above the list narrow it to the ticked
values. The review board draws its pull requests the same way, from the same cache, under the review's stacks and with
its short titles.

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
never does, a Responsibility such as on-call or code review, which never shows an ETA or goes done. New asks wait in
the Inbox at the top, then the rest sort into one list: what needs you, then what is due soonest, then in flight,
waiting and next. The Unplaced sessions and pull requests come last.

```
[ Period: all ▾ ]                              Updated 2m ago

Inbox
▸ next  Answer the vendor

▸ you   Grow the partner net…  1 Fri     → partners
▸ now   On-call                          → on-call
▸ next  Thread release notes             → notes
▸ Unplaced 3 sessions · 1 pull request
```

- **Kinds** are your own names for each level, such as Objective, Key result, Project and Task, or Thesis, Chapter
  and Experiment. The core names none of them.
- **Status** is one scale for everything: needs you, in flight, waiting, next, watching, done. A folded Item counts
  what needs you beneath it, so one deep in the tree shows at the top.
- **A line** shows the status and the title, cut to fit, then fixed columns at its right edge: how many things need
  you, when it is due, and the way to its session. The columns sit in the same place on every line, nested ones
  included. Only what needs you and what is late take color.
- **Sessions** sit under the Item they serve, with their state on the right: waiting on you, working, idle or done.
  Pressing one brings its herdr tab to the front. A top-level line ends in the label of the session leading it, the
  one that coordinates the others, and pressing it brings that session to the front; a deeper line ends in a mark. A session attaches by itself when its tab or workspace label
  carries an Item's id or alias, such as `abc-12-split-the-scope` for ABC-12; Claude links the rest by hand. A link
  follows the agent, so a session resumed in another tab keeps its place.
- **Pull requests** from every session's prs board sit under the Item whose id or alias their title or branch
  carries, such as `ABC-809 adds …` or `feature/abc-809`, or else under the Item of the session tracking them, the
  deepest when several do.
- **Dates**: a line shows the nearer of its target and ETA once it is inside a week, as a weekday, a countdown inside
  a day in yellow, red inside two hours, and `overdue` or `late` in red. An ETA is when whoever works an Item expects
  it done; a parent takes the latest ETA beneath it and is late once that falls after its target. Any Item takes an
  ETA, whatever its Source.
- **Time** spent is the active time of every session under an Item, finished ones included: a session's transcript
  from first entry to last, with every gap over five minutes cut out.
- **Periods**, such as quarters, cut the view to the Items dated in one, the undated work under them and their
  ancestors. Responsibilities and the Inbox show in every Period. Pick one in the Period box or with
  `/board work <period>`.
- **Sections** group the top level under names you choose, such as Goals, Side projects and Misc, each its own ranked
  list with its own done count. The tool's `sections` names them in order, and `section` puts a top-level Item of any
  Source in one; an Item put in none shows in the last, and an empty section is left out. With no sections the top
  level is one list.
- **Hidden**: the tool's `hide` leaves any Item, session or pull request out of the tree, with whatever sits under it,
  such as a pull request a Source attaches that is not yours to act on. `unhide` brings it back, and a read lists
  what is hidden.
- **Inbox**: an ask with no parent waits here, with who asked, until it is placed under an Item or work on it starts.
  One that grows into a whole effort is promoted where it stands: give it a Project's kind and an in-flight status,
  and it joins the list with its asker still kept.
- Pressing an Item opens its links, any board placed under it, its sessions by label and state, its pull requests
  and its children. Its detail and the rest stay behind its links and in the tool's read. The view re-reads its file
  every 15 seconds, and
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

- `add`, `update`, `remove`: local Items. Mark finished work `done` rather than removing it. `update` also sets the
  `eta` of an Item another Source holds.
- `link`, `unlink`: a hand-set parent for any Item, session or pull request. A session's parent can be another session,
  its Coordinator; a session keeps one Item parent and one Coordinator.
- `attach`: put this session under an Item.
- `start`: start a session for an Item with a brief, as this session's child. It opens a herdr tab named after the
  Item, in its branch's workspace or one of its own, starts the harness in it and sends the brief as the first prompt.
  `model` runs it on another model than the configured one. It is refused when the Item already has a running
  session, unless `again`.
- `root`: make this session the root, the one you talk to. Every breadcrumb and work view then starts with a `⌂` mark
  that brings it to the front.
- `aliases`: identifiers a workspace label, pull request title or branch may carry, such as an issue key.

The session view starts with where its session sits, such as `⌂ root  Grow the partner network › ABC-809  ↗`. The `⌂`
mark brings the root session to the front, and `↗` opens the work view down to this session. The [`root` skill](skills/root/SKILL.md) tells a root or coordinator
session how to rank what needs you, answer status, rollup and ETA questions from one tree read, start sessions with a
complete brief, and expect you to work with any session directly. The [`intake` skill](skills/intake/SKILL.md) is
one intake pass, run on a schedule such as `claude -p "/board:intake since <time>"`: it checks the sources your
instructions name for new asks and adds them to the tree, saying nothing when none came in. A read ends each ask's line with its link, so a pass knows what it already
added.

### Decisions

The root session's `decisions` view lists every Item whose own status is `needs`, from any Source: what blocks a
session waiting on you first, then the nearest due, then the one waiting longest. A line gives the ask, the session
that raised it, when it is due and how long it has waited. Pressing one opens its detail, where the options and the
recommendation live, its links and a way to the session that asked.

```
                                              Updated 1m ago
▸ Pick the fee route            fee-route              2h
▸ Approve the vendor plan       vendor-work    in 22h    
▸ Settle the fee account
 ▸ ✓ 2 answered
```

Any session that needs you adds the ask to the tree in the same turn it raises it, with its options and a
recommendation, and the root adds asks relayed to it; the work tool and the [`root` skill](skills/root/SKILL.md) say
so. The tool's `answer` records what you decided and marks the ask done, and it folds behind the answered count for a
week.

### The root's rollups

The root session's switcher adds two views drawn from the tree, each with a tab per section, or per Outcomes and
Responsibilities without sections, and a heading per top-level Item in it. A tab's count is what in it waits on you.

```
 Goals 1 · Side · Misc                 checked 2m ago
╭────────────────────────────────────────────╮
│ Grow the partner network                   │
│   ! #7502 CI fail      ABC-809 adds the f… │
│     #7600 review   lee ABC-809 adds a hook │
╰────────────────────────────────────────────╯
 ▸ ✓ 14 merged or closed
```

```
 Goals 1 · Code review                  polled 1m ago
Grow the partner network
▸   Partner stack         12 threads   3 PRs   3d ●
▸   Fee lookup             1 to pick    1 PR   5d ●
▸ ✓ Legacy removal                      1 PR   5d ●
```

- `all prs` holds every pull request the tree places, whoever wrote it, with the prs view's live state; what needs
  you comes first, and the merged and closed fold behind a count. Open ones placed nowhere get an Unplaced tab. While
  it is shown it asks GitHub for them through the prs view's shared cache.
- `all reviews` holds every running [pr-review-board](../pr-review-board/) review and every board a session wrote by
  hand, read from that plugin's own files. A line marks a review ✓ once its open pull requests are approved and ◆ once
  they merged, then says what it waits on: comments for you to pick, or its comments and your other threads on its
  open pull requests that wait on their author, `reviewing` while nothing is posted. Then its open pull requests, how
  long since it changed, and a dot that brings its session to the front. A review sits in the tab of its session's
  Item, or else of its first pull request the tree places. Pressing one opens its open pull requests.
- Both draw a pull request's state as one word that also carries its CI, and name an author only for someone else's
  pull request, and only where it differs from the row above.
- The tabs come from the tree, so the tool's `link`, `hide` and `sections` move a pull request to another tab, leave it
  out, or rename and reorder the tabs.

### Config

The `work` entry in `~/.config/board/boards.json` takes `layout: "model"`:

```json
{
  "id": "work",
  "layout": "model",
  "path": "~/workspace/work-board/board.json",
  "sources": {
    "rhythms": { "follow": ["OBJ-12"], "kinds": { "objective": "Objective", "key_result": "Key result" } },
    "linear": {
      "team": "ABC",
      "projects": [{ "name": "Partner Onboarding", "under": "rhythms:KR-34" }],
      "kinds": { "project": "Project", "issue": "Task" }
    },
    "github": {},
    "boards": { "oncall": "on-call" }
  },
  "hosts": { "herdr": { "cwd": "~", "session": "work", "workspaces": { "thesis": "thesis", "teaching": "teaching" } } },
  "harnesses": { "claude": { "args": ["--model", "opus[1m]"] } },
  "periods": [{ "name": "Q4 2026-27", "start": "2026-11-01", "end": "2027-01-31" }]
}
```

A Source left out of `sources` is off; with none, the view runs on the local file alone. `under` places a Source's
Item under one of yours, by id. `hosts` says where started sessions run, and `harnesses` which agent starts in them
and with what arguments. `hosts.herdr` takes `cwd`, the directory sessions start in; `session`, the herdr session
they run in, by default the starting session's own; and `workspaces`, a workspace label by Item id. A session started
for an Item opens as a tab in the workspace its nearest such ancestor names, made the first time. Otherwise a
session started by a coordinator opens as a tab beside it, and one started by the root in a workspace of its own. `periods` are named date ranges, the end date included. A key
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
    { "id": "rollout", "path": "~/boards/rollout.json", "layout": "rollout", "under": "launch" }
  ],
  "link_labels": { "dashboard.example.com": "Dashboard" },
  "link_pairs": [
    { "first": "https://dash.example.com/order/", "second": "https://dash.example.com/contract/", "label": "contract" }
  ]
}
```

- `layout`: left out, a board draws one colored box per status. `rollout` draws a rollout, below; `model` is the
  work view.
- `under`: the work view Item a board belongs to. Its tab shows only in the sessions working under that Item, or
  coordinated by one that is, and a line under the Item opens it from anywhere. Left out, every session has the tab.
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
  "title": "Partner rollout",
  "envs": ["staging", "prod"],
  "sections": [
    {
      "id": "gates",
      "title": "Gates, in flip order",
      "items": [
        {
          "id": "g-partner",
          "title": "release.order_service.partner_onboarding",
          "status": "todo",
          "owner": "Dana",
          "note": "Umbrella flag",
          "env": { "staging": "on", "prod": "off" },
          "after": ["g-routing"],
          "detail": "markdown",
          "links": [{ "label": "Gate", "url": "url" }],
          "work": "file:partner"
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
