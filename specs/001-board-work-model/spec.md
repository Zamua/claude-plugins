# Feature Specification: Board Work Model

**Feature Branch**: none, work lands on `main` (see the constitution's Development Workflow)
**Created**: 2026-10-27
**Status**: Draft
**Input**: User description: "Board work model: a field-agnostic way for the board plugin's `work`
view to show one person's whole body of work as a tree, from their highest-level goals down to the
agent sessions doing the work, with everything that needs them surfaced at the top."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See all my work as one tree, with what needs me on top (Priority: P1)

The person opens the work view and sees everything they are responsible for, one line per top-level
Item: their goals and projects that end, and the responsibilities that never do, such as on-call,
code review and side projects. Each line shows its Kind, its title, its rolled-up status and how
many Items under it need the person. Pressing a line opens its children, down to the smallest task.
Today's hand-kept work board moves into this tree without losing anything.

**Why this priority**: it replaces the current work board and is useful on its own, read entirely
from the board's local file, before any external Source is connected.

**Independent Test**: migrate today's work board, open the work view, and confirm every group and
item appears with its title, status, links and dates, and that an item needing the person is counted
on its top-level line.

**Acceptance Scenarios**:

1. **Given** a migrated work board with a "needs you" item three levels deep, **When** the person
   opens the work view, **Then** the item's top-level line shows a "needs you" count of 1 and the
   item itself is not drawn until its ancestors are opened.
2. **Given** a top-level line, **When** the person presses it, **Then** its children appear beneath
   it, each on one line, and pressing it again folds them.
3. **Given** Outcomes and Responsibilities at the top level, **When** the view draws, **Then**
   Responsibilities are drawn as their own group beside the Outcomes, not under any of them.
4. **Given** an Outcome whose descendants are all done, **When** the view draws, **Then** it rolls
   up to done and is folded behind a "N done" count at its level.

---

### User Story 2 - My goals and tasks come from where they already live (Priority: P2)

The person's objectives and key results appear from their goal tracker, and their projects and
tasks from their issue tracker, placed in the same tree without being copied by hand. Progress and
the next check-in date of a goal show on its line. The data stays fresh without any session asking
the same tracker more often than needed.

**Why this priority**: it removes the hand upkeep that makes the current board drift, but it needs
the tree from Story 1 to land in.

**Independent Test**: configure one followed goal and one issue-tracker project linked beneath one
of its key results, open the work view, and confirm the goal, its key results with progress, and
the project's open tasks appear in place.

**Acceptance Scenarios**:

1. **Given** a followed goal with three key results, **When** the work view refreshes, **Then** the
   goal and its key results appear with their progress and status, under the Kind names configured
   for those levels.
2. **Given** an issue-tracker project linked under a key result, **When** the view refreshes,
   **Then** the project and its open tasks appear under that key result.
3. **Given** several sessions showing the work view at once, **When** they refresh, **Then** each
   external Source is asked at most once per freshness window, and the others reuse that answer.
4. **Given** a Source that fails or is rate-limited, **When** the view draws, **Then** the last known
   Items stay, and the freshness line says which Source failed and when it will be asked again.

---

### User Story 3 - Sessions and pull requests attach to the work they serve (Priority: P3)

Each running agent session and each pull request appears under the Item it serves, found from the
identifiers already in its workspace name, branch or title. A session can sit at any level: a
session coordinating a goal tracks project sessions, which track task sessions, and an on-call
session tracks the sessions investigating each alert. Where no identifier matches, the person, or
Claude on their behalf, links it by hand.

**Why this priority**: it answers "which agents are working on this, and what did they produce",
the question the person asks most while coordinating many sessions.

**Independent Test**: start sessions in workspaces named after two tasks and one coordinating
session linked to their project, open the work view, and confirm each session sits under its task,
the coordinator sits under the project and lists the two task sessions as its children.

**Acceptance Scenarios**:

1. **Given** a session whose workspace name contains a task's identifier, **When** the view
   refreshes, **Then** the session appears under that task with its state (working, waiting on the
   person, idle) on one line.
2. **Given** a pull request whose title or branch contains a task's identifier, **When** the view
   refreshes, **Then** the pull request appears under that task with its review and CI state.
3. **Given** a session linked by hand to a Responsibility, **When** the view refreshes, **Then** it
   appears under that Responsibility, and a hand link always wins over an inferred one.
4. **Given** a session tracking child sessions, **When** the person opens it, **Then** its child
   sessions appear beneath it.
5. **Given** a session that matches no Item, **When** the view draws, **Then** it appears in an
   unplaced group, so no running session is invisible.
6. **Given** an Item with a session attached, **When** the person presses the Item's session mark,
   **Then** that session comes to the front where it runs; with several attached, the most recently
   active one does, and opening the Item lists them all.
7. **Given** sessions run under a different terminal multiplexer or agent harness, **When** an
   adapter for it is configured instead, **Then** every scenario above holds with no change outside
   that adapter.

---

### User Story 4 - Each session knows where it sits (Priority: P4)

The session view shows a one-line breadcrumb of the Item its session is attached to, from the top of
the tree down to the session, such as "Q4 › CRB funding › MM-809 › this session". Pressing a step
opens the work view at that Item.

**Why this priority**: it keeps the person and the agent oriented in a single session, but it
depends on Story 3's attachments.

**Independent Test**: attach a session to a task three levels deep and confirm its session view
shows the full path on one line.

**Acceptance Scenarios**:

1. **Given** an attached session, **When** its session view draws, **Then** the breadcrumb shows
   every ancestor's title in order, cut at the pane's edge from the left rather than wrapping.
2. **Given** an unattached session, **When** its session view draws, **Then** no breadcrumb is
   drawn.

---

### User Story 5 - Deadlines, time spent and periods (Priority: P5)

An Item with a target date shows it on its line, turning yellow inside a day and red inside two
hours or when past, as the work board does today. An Item's time spent is the active time of the
sessions under it, rolled up the tree. The person can group or filter the tree by a named Period,
such as a quarter or a semester.

**Why this priority**: it sharpens the view once the tree, Sources and sessions exist.

**Independent Test**: give a task a target date tomorrow and run two sessions under it, then confirm
its line shows the date and the parent shows the sum of both sessions' active time.

**Acceptance Scenarios**:

1. **Given** an Item due in under two hours, **When** the view draws, **Then** its date shows in red
   as a countdown.
2. **Given** a Period configured as a date range, **When** the person filters by it, **Then** only
   Items whose dates fall in that range, and their ancestors, are drawn.

---

### User Story 6 - An inbox for asks that fit nowhere yet (Priority: P6)

A request from someone that does not belong to any existing Item lands in an Inbox at the top level,
marked with its Origin and who asked. Placing it moves it under the Item it concerns.

**Why this priority**: it keeps stray asks from being lost, but most asks belong under an existing
Item and are filed there directly.

**Independent Test**: add an ask with no parent, confirm it shows in the Inbox with who asked, then
place it under a project and confirm it moves.

**Acceptance Scenarios**:

1. **Given** an ask with no parent, **When** the view draws, **Then** it appears in the Inbox with
   its Origin and requester.
2. **Given** an ask in the Inbox, **When** it is placed under an Item, **Then** it leaves the Inbox
   and appears under that Item.

---

### Edge Cases

- An Item two Sources both claim, such as a task linked by hand under one project but listed by its
  tracker under another: the hand link wins, and the Item is drawn once.
- A session or pull request whose name matches two Items: it attaches to the deepest match; if two
  matches are equally deep it goes to the unplaced group.
- A Source removes an Item that a hand link points at: the link is kept and reported as dangling, not
  silently dropped.
- A hand link that would make an Item its own ancestor: the link is refused with a reason.
- A Responsibility given a target date: the date is ignored for the Responsibility and kept for its
  children, since a Responsibility never ends.
- A tree deeper than the pane can indent legibly: deeper levels are reached by opening, and the
  breadcrumb carries the path.
- A finished session: it leaves the tree, and its active time still counts toward its Item.
- No external Source is configured: the tree works from the local file alone.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The board MUST model work as Items nested in a tree of any depth, each Item either an
  Outcome or a Responsibility.
- **FR-002**: The core model MUST NOT name any field, company or tool; level names MUST come from
  Kinds the person configures as plain names in the board's configuration file.
- **FR-003**: Each Item MUST have exactly one Source, and each Source MUST be read through its own
  adapter that maps it into Items, Kinds, Status, Origin and dates.
- **FR-004**: The board MUST store locally only what no Source holds: Responsibilities, side
  projects, unplaced asks, and links it cannot infer.
- **FR-005**: Every Item MUST have a Status on one scale: needs you, in flight, waiting, next,
  watching, done. A parent MUST show the most urgent Status among its descendants and a count of
  descendants that need the person.
- **FR-006**: The work view MUST draw one line per Item, start with only top-level Items shown, open
  and fold an Item's children on press, and show the data's freshness in the top right.
- **FR-007**: Responsibilities MUST be drawn as their own group at the top level, beside the
  Outcomes.
- **FR-008**: An Item MAY carry a target date, a started date and a finished date; the view MUST show
  a target date with the same near and past coloring the work board uses today.
- **FR-009**: The person MUST be able to define named Periods as date ranges and filter the tree by
  one.
- **FR-010**: The board MUST read the goal tracker's objectives and key results the person follows,
  with progress, status and next check-in date, and the issue tracker's projects and tasks.
- **FR-011**: The person MUST be able to choose which goals, teams or projects each Source follows,
  since the person may own none of the goals their work serves.
- **FR-012**: External Sources MUST be read through a cache shared by every session, asked only by
  sessions in use, and never asked while their rate limit is low.
- **FR-013**: The board MUST attach Sessions and Artifacts to Items by matching identifiers found in
  workspace names, branch names and pull request titles.
- **FR-014**: The person, or Claude on their behalf, MUST be able to link an Item, Session or
  Artifact to a parent by hand; a hand link MUST win over an inferred one.
- **FR-015**: A Session MUST be attachable to an Item at any level, and MAY track child Sessions,
  drawn beneath it.
- **FR-016**: An Item's time spent MUST be the active time of the Sessions under it, summed up the
  tree, including Sessions that have finished.
- **FR-017**: The session view MUST show a one-line breadcrumb of its Session's attachment when it
  has one.
- **FR-018**: An ask with no parent MUST appear in an Inbox with its Origin and requester until
  placed.
- **FR-019**: Migrating today's work board MUST carry over every group and item with its title,
  status, detail, links, due date and workspace, and report anything it could not place.
- **FR-020**: When a Source fails, its last known Items MUST stay drawn, and the freshness line MUST
  name the failing Source.
- **FR-021**: An Item with a Session attached MUST show a session mark on its line, colored by the
  Session's state; pressing the mark MUST bring that Session to the front where it runs.
- **FR-022**: The core model MUST NOT name a terminal multiplexer or an agent harness. Sessions MUST
  come from a Host adapter, which lists where sessions run and brings one to the front, and a
  Harness adapter, which identifies the agent in a session and reads its active time.

### Key Entities

- **Item**: one unit of work at any depth. Has a title, a Kind, a Source, a parent, an Outcome or
  Responsibility flag, a Status, an Origin, optional dates, links, and its children.
- **Kind**: the person's name for a level, such as Objective, Key result, Project, Task, or Thesis,
  Chapter, Experiment.
- **Source**: a system Items are read from, such as a goal tracker, an issue tracker, a code host,
  the workspace manager or the board's local file. Owns its Items' content.
- **Origin**: why an Item exists: planned, asked, interrupt or self-started; an ask also records who
  asked.
- **Status**: the one scale shared by every Item, rolled up from descendants.
- **Period**: a named date range used to group or filter.
- **Session**: an agent working somewhere a Host can find and focus, attached to one Item at any
  level, with a state, active time and optional child Sessions.
- **Host**: where Sessions run, such as a terminal multiplexer: it lists them with a name and a
  state, and brings one to the front.
- **Harness**: the agent runtime inside a Session, such as Claude Code: it gives the Session's own
  id and its active time.
- **Artifact**: something an Item produces, such as a pull request or a document, attached to an
  Item.
- **Link**: a hand-set parent for an Item, Session or Artifact, stored locally.
- **Inbox**: the top-level holding place for asks with no parent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With up to 200 Items, the person can name every Item that needs them within 10 seconds
  of opening the work view, without scrolling: every top-level line carries its count.
- **SC-002**: Migration carries over 100% of today's work board groups and items, checked by
  comparing counts and titles before and after.
- **SC-003**: At least 90% of the person's running sessions attach to an Item with no hand link,
  measured across their open workspaces on a normal working day.
- **SC-004**: Over a working week, the board causes no rate-limit errors and asks each external
  Source at most once per freshness window across all sessions.
- **SC-005**: A person in another field can use the work view with their own Kind names and the local
  file alone, with no code change, shown with an academic example configuration.
- **SC-006**: The time between a Source changing and the change showing in the work view is no
  longer than that Source's freshness window plus one refresh.

## Assumptions

- One person on one machine; multi-person views are out of scope.
- The board only reads Sources: it posts no check-ins and edits no tracker. Editing Kinds in a UI is
  out of scope; Kinds are names in the configuration file.
- The first user's Kinds are Objective, Key result, Project and Task, read from Rhythms (objectives
  and key results) and Linear (projects and issues); pull requests come from GitHub, Responsibilities
  from the local file, and sessions from herdr as the Host with Claude Code as the Harness.
- A goal-tracker key result and an issue-tracker project share no identifier, so that link is set by
  hand once per project.
- Agents keep the local file current, as they keep today's work board current; the board needs no
  editing UI beyond pressing, plus a tool Claude can call to add Items and set links.
- The on-call view stays as it is; its items also appear under the On-call Responsibility.
- "Active time" for a session means time during which it was running a turn, as the workspace
  manager reports it.
- Freshness windows default to those already proven in the board: minutes for code-host data, and
  longer for goals, which change weekly.
