# Tasks: Board Work Model

**Input**: design documents in `specs/001-board-work-model/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: included. The constitution's Mod Constraints require `claude plugin test` to pass on
every change, and Principle VI sets how tests are written: assert drawn lines and tool results,
stub only CLIs, MCP answers, files and the clock.

**Organization**: one phase per user story, in the spec's priority order. Each story ends with a
live check and a version bump, so each ships alone.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task serves (US1 to US6)
- Paths are relative to the repository root; the plugin is `plugins/board/`

---

## Phase 1: Setup

**Purpose**: test harness and configuration every story needs.

- [X] T001 Extend the test harness in `plugins/board/tests/engine.ts`: let `world()` take canned answers for `tool.call` by tool name (`mcp`), and for `process.run` by command (`linear`, `herdr`), returning `{ exitCode, stdout, stderr }`; record each call so tests can count them
- [X] T002 Parse the `model` layout in `plugins/board/hooks/register.tsx`: accept a board entry with `layout: "model"` and its `sources` and `periods` objects per `contracts/config.md`; ignore unknown keys with one warning line; keep `sections` and `groups` boards working as before

---

## Phase 2: Foundational

**Purpose**: the core model and the shared cache, used by every story. No story starts before these.

- [X] T003 Define the core types in `plugins/board/hooks/work/model.ts`: `Item`, `Status` (`needs`, `flight`, `waiting`, `next`, `watching`, `done` in urgency order), `Origin`, `Session`, `Artifact`, `Link`, `Period`, and the `SourceSpec` and `SourceAnswer` types from `contracts/source-adapter.md`; no `$`, no tool or company names
- [X] T004 Implement `buildTree(answers, links)` in `plugins/board/hooks/work/model.ts` per data-model.md "Tree": gather Items from every answer, apply Links over Source parents, put an Item whose parent is missing or would form a cycle at the top level with a warning, order the top level as Outcomes, Responsibilities, Inbox, Unplaced
- [X] T005 Implement rollup in `plugins/board/hooks/work/model.ts`: each node's shown status is the most urgent among itself and its descendants, `needsCount` counts descendants whose own status is `needs`, `activeMs` sums its Sessions' active time
- [X] T006 [P] Create the shared Source cache in `plugins/board/hooks/work/cache.ts`: one file per Source at `~/.cache/board/<source>.json` holding `{ at, answer, pausedUntil?, pauseReason? }`; `readSource` returns the cached answer while younger than the Source's `freshMs`, otherwise asks the adapter, writes the answer by read, change, write, and on failure keeps the last answer and returns the error; asks only when the session was active in the last 30 minutes, following the pattern in `plugins/board/hooks/views/prs.tsx`

**Checkpoint**: the model builds and rolls up a tree from plain data.

---

## Phase 3: User Story 1 - See all my work as one tree (Priority: P1) 🎯 MVP

**Goal**: the work view draws the tree from the local file, folded to the top level, with needs counts; today's work board migrates without loss.

**Independent Test**: migrate the work board, open the work view, and confirm every group and item appears, and a needs-you item three levels deep counts on its top-level line.

### Tests for User Story 1

- [X] T007 [P] [US1] Write `plugins/board/tests/work-model.test.ts`: a local file with a `needs` Item three levels deep shows count 1 on its top-level line and is not drawn until its ancestors are pressed open; pressing a line opens and folds its children; Responsibilities draw after Outcomes; an Outcome whose descendants are all done folds behind "1 done"; the freshness stamp is in the top right
- [X] T008 [P] [US1] Write `plugins/board/tests/work-migrate.test.ts`: a version 1 file with nested groups, items in every section, links, `due` and `workspace` becomes version 2 with the same counts and titles, statuses carried over, `due` as `target`, the `tooling` group as a Responsibility, `board.v1.json` written beside it, and a report naming any item it could not place
- [X] T009 [P] [US1] Write `plugins/board/tests/work-tool.test.ts`: `mcp__board__work` with no input returns one line per Item with id, kind, status and needs count; `add`, `update` (including `parent`), `remove`, `link` and `unlink` change the file and redraw the view; a change naming an unknown id, editing a non-local Item, making a cycle, or removing an Item with children is refused whole with its reason

### Implementation for User Story 1

- [X] T010 [US1] Implement the local file Source in `plugins/board/hooks/work/sources/file.ts` per `contracts/local-file.md`: read a version 2 file into Items (ids prefixed `file:`) and Links, keep unknown fields, treat a missing file as empty, report a parse failure as the Source's error
- [X] T011 [US1] Implement the migration in `plugins/board/hooks/work/migrate.ts` per the table in `contracts/local-file.md`: write `board.v1.json` first, then the version 2 file, and return counts before and after plus anything not placed
- [X] T012 [US1] Add `/board work migrate` in `plugins/board/hooks/register.tsx`: run the migration on the configured `path` once, refuse when the file is already version 2, and print the migration's report
- [X] T013 [US1] Implement `mcp__board__work` in `plugins/board/hooks/work/tool.tsx` per `contracts/work-tool.md`: register it at `session.start`, allow it in `tool.check`, validate the whole change against the current tree before writing, write the file by read, change, write, then invalidate the work view
- [X] T014 [US1] Implement the work view in `plugins/board/hooks/work/view.tsx`: build the tree from the file Source, draw one line per Item (kind dim, title, shown status color, needs count), keep fold state per session in module memory, open and fold on press, fold done children behind "N done", and draw the freshness stamp with `stamp()` from `plugins/board/hooks/kit.tsx`
- [X] T015 [US1] Wire the view and tool into `plugins/board/hooks/register.tsx`: a `model` board uses the work view instead of the file view, the tool's guide joins the `prompt.compose` section, and the tool's hooks register as bare statements per the validator's rules
- [X] T016 [US1] Live check and ship: run validate, `tsc` and tests; migrate the real `~/workspace/work-board/board.json` with `/board work migrate` and compare counts and titles against `board.v1.json` (SC-002); switch the `work` board to `layout: "model"` in `~/.config/board/boards.json`; look at the view in a live session; rewrite `~/workspace/work-board/README.md` to say agents change the file through `mcp__board__work`; bump `plugins/board/.claude-plugin/plugin.json`, commit and push

**Checkpoint**: the work view replaces the hand-kept groups board.

---

## Phase 4: User Story 2 - Goals and tasks from their trackers (Priority: P2)

**Goal**: Rhythms objectives and key results, Linear projects and issues, and the on-call board appear in the tree, cached and shared.

**Independent Test**: follow one goal and one Linear project linked under one of its key results; confirm both appear with progress and open tasks, and a second session reuses the cache.

### Tests for User Story 2

- [ ] T017 [P] [US2] Write Linear cases in `plugins/board/tests/work-sources.test.ts`: a stubbed `linear issue list --json` answer becomes a Project Item under its configured `under` parent with Task children; state types map per research R8; a second refresh inside the fresh window runs no `linear` command; a failing command keeps the last Items and names Linear on the freshness line
- [ ] T018 [P] [US2] Write Rhythms cases in `plugins/board/tests/work-sources.test.ts`: a stubbed `mcp__rhythms__search_knowledge` answer becomes an Objective with Key result children carrying progress and the configured Kind names; `checkinDue` is the Monday after the last check-in; the board's `tool.check` allows only its own read calls to the listed Rhythms tools and leaves the model's own calls alone
- [ ] T019 [P] [US2] Write `boards` Source cases in `plugins/board/tests/work-sources.test.ts`: the oncall board's items appear as children of the configured local Item, with their section as status

### Implementation for User Story 2

- [ ] T020 [US2] Spike research R1 in a live session: call `mcp__rhythms__search_knowledge` through `$.tool.call` from a `$.clock.every` callback outside a turn; record the result in `specs/001-board-work-model/research.md` R1 and, if it fails, refresh Rhythms only on `turn.start` and when the view is shown
- [ ] T021 [P] [US2] Implement `plugins/board/hooks/work/sources/linear.ts`: one `linear issue list --team <team> --project <name> --all-states --all-assignees --json` per configured project, Items `linear:<identifier>` with the identifier as an alias, the project as a parent Item, `under` applied, Kinds from config, through `readSource` in `plugins/board/hooks/work/cache.ts`
- [ ] T022 [P] [US2] Implement `plugins/board/hooks/work/sources/rhythms.ts`: one `search_knowledge` call with the followed goals' ids and `include_children`, Items `rhythms:<short id>` with progress, status per R8, owner and `checkinDue`; register its `tool.check` hook as a bare statement allowing only the board-origin calls
- [ ] T023 [P] [US2] Implement `plugins/board/hooks/work/sources/boards.ts`: read another configured board's file and place its items under the named local Item, reusing the file reading in `plugins/board/hooks/views/file.tsx`
- [ ] T024 [US2] Live check and ship: add `rhythms`, `linear` and `boards` sources to `~/.config/board/boards.json` (follow OBJ-2346; CRB Funding - Money Movement under its instant-funding key result), confirm one `at` per cache file across two sessions, bump the version, commit and push

**Checkpoint**: goals and tasks arrive without hand copying.

---

## Phase 5: User Story 3 - Sessions and pull requests attach to their work (Priority: P3)

**Goal**: each running session and each pull request sits under the Item it serves, inferred from ids or linked by hand; coordinator sessions show their children.

**Independent Test**: two task sessions and one coordinator linked to their project appear in place, with the coordinator listing both.

### Tests for User Story 3

- [ ] T025 [P] [US3] Write `plugins/board/tests/work-session.test.ts`: stubbed `herdr session list` and `pane list` answers become Sessions; a label containing `mm-809` attaches under the Item with alias `MM-809`; the deepest match wins; two equally deep matches go to Unplaced; a hand link beats a match; a session linked to another session draws beneath it; an unmatched session shows in Unplaced
- [ ] T026 [P] [US3] Write Artifact cases in `plugins/board/tests/work-session.test.ts`: a pull request on a stored prs board whose title starts `MM-809` attaches under that Item with its review and CI state from the GitHub cache, and makes no `gh` call

### Implementation for User Story 3

- [ ] T027 [US3] Implement alias matching in `plugins/board/hooks/work/model.ts` per research R6: lowercase, whole-token match bounded by non-alphanumerics, deepest Item wins, equal depth goes to Unplaced, Links first
- [ ] T028 [P] [US3] Implement `plugins/board/hooks/work/sources/herdr.ts`: `herdr session list`, then `herdr --session <name> pane list` per session, keeping `agent: claude` panes as Sessions with label, workspace, Claude session id and status
- [ ] T029 [P] [US3] Implement `plugins/board/hooks/work/sources/github.ts`: read every stored prs board from the plugin store and the facts in `~/.cache/board/github.json`, producing Artifacts with title, branch and facts; no network calls
- [ ] T030 [US3] Add `attach` and session references to `plugins/board/hooks/work/tool.tsx`: `attach` links the calling session (`session:<id>`) to a parent; `link` accepts Session and Artifact ids as children and Session ids as parents
- [ ] T031 [US3] Draw Sessions and Artifacts in `plugins/board/hooks/work/view.tsx`: a Session line shows its label and herdr status and focuses its workspace on press via `focusWorkspace`; an Artifact line uses `prRow` from `plugins/board/hooks/kit.tsx`; Unplaced draws last
- [ ] T032 [US3] Live check and ship: confirm at least 90% of open workspaces attach with no hand link (SC-003), attach the CRB architecture session to its Responsibility by hand, bump the version, commit and push

---

## Phase 6: User Story 4 - Each session knows where it sits (Priority: P4)

**Goal**: the session view shows a one-line breadcrumb of its attachment.

**Independent Test**: a session attached three levels deep shows its full path on one line.

- [ ] T033 [P] [US4] Add breadcrumb cases to `plugins/board/tests/work-session.test.ts`: an attached session's view shows every ancestor's title in order on one line; an unattached session's view shows none; pressing a step opens the work view with that Item's ancestors open
- [ ] T034 [US4] Export the last built tree and a `pathOf(sessionId)` lookup from `plugins/board/hooks/work/view.tsx`, and draw the breadcrumb in `plugins/board/hooks/views/session.tsx` above the goal, cut from the left with `truncate-start`
- [ ] T035 [US4] Live check and ship: bump the version, commit and push

---

## Phase 7: User Story 5 - Deadlines, time spent and periods (Priority: P5)

**Goal**: target dates on lines, active time rolled up from sessions, Period filtering.

**Independent Test**: a task due tomorrow shows yellow, and its parent shows the summed active time of two sessions under it.

- [ ] T036 [P] [US5] Write `plugins/board/tests/work-time.test.ts`: a target inside two hours draws red as a countdown, inside a day yellow; a transcript with prompts and entries yields active time with gaps over 5 minutes cut; a parent sums its sessions' time, finished ones included; `/board work <period>` draws only Items whose dates fall in it, with their ancestors
- [ ] T037 [US5] Compute active time in `plugins/board/hooks/work/sources/herdr.ts` from `~/.claude/projects/*/<session id>.jsonl` per research R5, caching each result by transcript mtime in `~/.cache/board/time.json`
- [ ] T038 [US5] Draw dates with `dueOf` and time with `span` from `plugins/board/hooks/kit.tsx` in `plugins/board/hooks/work/view.tsx`, and accept a Period name as `/board work <period>` in `plugins/board/hooks/register.tsx`
- [ ] T039 [US5] Live check and ship: bump the version, commit and push

---

## Phase 8: User Story 6 - An inbox for asks (Priority: P6)

**Goal**: asks with no parent wait in an Inbox until placed.

**Independent Test**: an ask with no parent shows in the Inbox with who asked, and moves once placed.

- [ ] T040 [P] [US6] Add Inbox cases to `plugins/board/tests/work-tool.test.ts`: an `add` with `origin.type: "asked"` and no parent draws under Inbox with the requester; an `update` with `parent` moves it out
- [ ] T041 [US6] Place parentless asks in the Inbox group in `buildTree` in `plugins/board/hooks/work/model.ts` and draw the group in `plugins/board/hooks/work/view.tsx`
- [ ] T042 [US6] Live check and ship: bump the version, commit and push

---

## Phase 9: Polish

- [ ] T043 [P] Document the work model in `plugins/board/README.md`: the tree, Kinds, each Source and its config, the work tool, migration; make `plugins/board/.claude-plugin/plugin.json` and its `.claude-plugin/marketplace.json` entry say the same thing (Constitution VII)
- [ ] T044 [P] Remove the `groups` layout from `plugins/board/hooks/views/file.tsx` and its tests in `plugins/board/tests/file-board.test.ts` once no configured board uses it (Constitution I)
- [ ] T045 Run every block in `specs/001-board-work-model/quickstart.md` in a live session and check SC-001 to SC-006

---

## Dependencies & Execution Order

### Phase dependencies

- Setup (T001 to T002) first; Foundational (T003 to T006) blocks every story.
- US1 (Phase 3) is the MVP and comes first: every later story draws into its view.
- US2, US3 and US6 depend only on US1 and may run in any order after it.
- US4 depends on US3 (attachments); US5's active time depends on US3's herdr Source.
- Polish last.

### Within each story

Tests first, then Sources and model changes, then the view and tool, then the live check and ship.

### Parallel opportunities

- T006 beside T003 to T005.
- T007, T008 and T009 together; T017, T018 and T019 together; T021, T022 and T023 together;
  T025 and T026 together; T028 and T029 together.
- After US1, US2 and US3 can proceed side by side in separate sessions.

## Parallel Example: User Story 2

```text
T017 Linear tests, T018 Rhythms tests, T019 boards tests   # one file, separate describe blocks
T021 linear.ts, T022 rhythms.ts, T023 boards.ts            # separate files
```

## Implementation Strategy

### MVP first

1. Setup and Foundational.
2. User Story 1, through T016's live check.
3. Stop and use it for a day before Story 2.

### Incremental delivery

Each story ends in its own plugin version. Ship, reload the sessions, look at it live, then start
the next story.

## Notes

- Every task that ends a story runs `claude plugin validate`, `tsc` and `claude plugin test` before
  its commit (Constitution, Mod Constraints).
- The validator lets `$` reach only function declarations and wants each atom read in its own file;
  keep each view's atoms in that view's file.
- The memory note on the work board (`~/.claude/projects/-Users-zamua/memory/work-board.md`) needs
  updating once T016 ships.
