# Tasks: Board Work Model

**Input**: design documents in `specs/001-board-work-model/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: included. The constitution's Mod Constraints require `claude plugin test` to pass on
every change, and Principle VI sets how tests are written: assert drawn lines and tool results,
stub only CLIs, MCP answers, files and the clock.

**Organization**: one phase per user story, in the spec's priority order: US1, US3, US4, US2, US5,
US6. Each story ends with a live check and a version bump, so each ships alone.

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

## Phase 4: User Story 3 - Sessions and pull requests attach to their work (Priority: P2)

**Goal**: each running session and each pull request sits under the Item it serves, inferred from ids or linked by hand; Coordinators show their Sessions; Claude can start a Session for an Item; the tree read gives each Session's state, summary and message name.

**Independent Test**: two task sessions and one coordinator linked to their project appear in place, with the coordinator listing both; a session the coordinator starts for a third task appears under it at once.

### Tests for User Story 3

- [X] T017 [P] [US3] Write `plugins/board/tests/work-session.test.ts`: stubbed herdr Host answers (`herdr session list`, `pane list`) become Sessions with ids `session:herdr:<address>`; a label containing `mm-809` attaches under the Item with alias `MM-809`; the deepest match wins; two equally deep matches go to Unplaced; a hand link beats a match; a session with a Coordinator Link draws beneath its Coordinator and keeps its Item Link; an unmatched session shows in Unplaced; an Item with sessions shows a session mark colored by state, and pressing it runs the Host's focus for the most recently active one
- [X] T018 [P] [US3] Write start and read cases in `plugins/board/tests/work-tool.test.ts`: `start` with an Item and a brief runs the Host's create, agent start and prompt commands with a label from the Item's alias and title and the Harness's launch command, writes the Item and Coordinator Links keyed by the new address, and the new session draws under the Item before the Host lists it; a start for an Item with a running session is refused naming that session and its message name unless `again: true`; a read lists each Session under its Item with state, message name, and goal and summary from its stored session board
- [X] T019 [P] [US3] Write Artifact cases in `plugins/board/tests/work-session.test.ts`: a pull request on a stored prs board whose title starts `MM-809` attaches under that Item with its review and CI state from the GitHub cache, and makes no `gh` call

### Implementation for User Story 3

- [X] T020 [US3] Implement alias matching in `plugins/board/hooks/work/model.ts` per research R6: lowercase, whole-token match bounded by non-alphanumerics, deepest Item wins, equal depth goes to Unplaced, Links first; Sessions get `item` and `coordinator` separately per data-model.md
- [X] T021 [P] [US3] Implement the herdr Host in `plugins/board/hooks/work/hosts/herdr.ts` per `contracts/source-adapter.md`: `listSessions` runs `herdr session list`, then `herdr --session <name> pane list` per session, keeping panes with an `agent`, and maps herdr's status words to working, waiting, idle or done; `focusSession` focuses a workspace by address; `startSession` runs the recipe in research R4 and returns the new address. Move `focusWorkspace` out of `plugins/board/hooks/kit.tsx` into this module and have `plugins/board/hooks/views/file.tsx` call it from there; accept `hosts` and `harnesses` in `SPEC_KEYS` in `plugins/board/hooks/work/view.tsx`
- [X] T022 [P] [US3] Implement the Claude Code Harness in `plugins/board/hooks/work/harnesses/claude.ts`: `sessionInfo` gives last activity from the transcript's mtime under `~/.claude/projects/*/<session id>.jsonl` and the message name from the `~/.claude/sessions/*.json` record whose `sessionId` matches (research R5); `launchCommand` returns `claude` plus the configured `args`; active time follows in T041
- [X] T023 [P] [US3] Implement `plugins/board/hooks/work/sources/github.ts`: read every stored prs board from the plugin store and the facts in `~/.cache/board/github.json`, producing Artifacts with title, branch and facts; no network calls
- [X] T024 [US3] Extend `plugins/board/hooks/work/tool.tsx` per `contracts/work-tool.md`: `attach` finds the calling session's address by matching `$.session.id()` to a Host session's `harnessId` (research R10); `link` accepts Session and Artifact children and Session parents, keeping one Item Link and one Coordinator Link per Session; `start` refuses an Item with a running Session unless `again`, calls the Host's `startSession`, then writes both Links; the read adds one line per Session with state and message name, and its goal and summary from the stored session board; update the tool's description and input schema to match
- [X] T025 [US3] Draw Sessions and Artifacts in `plugins/board/hooks/work/view.tsx`: a Session line shows its label and state and focuses it on press through its Host's `focusSession`; a Coordinator's Sessions draw beneath it; an Item with sessions gets a one-glyph session mark (●) colored by the most urgent session state, which focuses the most recently active session (spec FR-021); an Artifact line uses `prRow` from `plugins/board/hooks/kit.tsx`; Unplaced draws last
- [X] T026 [US3] Live check and ship: confirm at least 90% of open workspaces attach with no hand link (SC-003); from this session, start a session for one Item with a short brief and confirm it appears under the Item with this session as Coordinator and gets the brief; message it by the name the read gives; close its workspace; attach the CRB architecture session to its Responsibility by hand; bump the version, commit and push

**Checkpoint**: one session can start, track and reach the others.

---

## Phase 5: User Story 4 - Each session knows where it sits, and the way back to the root (Priority: P3)

**Goal**: the breadcrumb, the root session and its mark, and the work view opened down to the current session.

**Independent Test**: a session attached three levels deep shows its full path on one line, its work view opens down to it, and the root mark brings the root session to the front.

- [X] T027 [P] [US4] Add breadcrumb and root cases to `plugins/board/tests/work-session.test.ts`: an attached session's view shows every ancestor's title in order on one line; an unattached session's view shows none; pressing a step opens the work view with that Item's ancestors open; with a root set, the breadcrumb and the work view's title line start with a root mark that runs the Host's focus for the root session, drawn dim once that session has ended; `root: true` through the tool sets the file's `root`; an attached session's work view first draws with its Item's ancestors open and its own line marked
- [X] T028 [US4] Add `root` to `plugins/board/hooks/work/tool.tsx`, writing the calling session's id to the local file's `root`; export the last built tree and a `pathOf(sessionId)` lookup from `plugins/board/hooks/work/view.tsx`; draw the breadcrumb in `plugins/board/hooks/views/session.tsx` above the goal, root mark first, cut from the left with `truncate-start`
- [X] T029 [US4] In `plugins/board/hooks/work/view.tsx`, draw the root mark on the title line, and on the first draw in an attached session open its Item's ancestors and mark its own line; in `plugins/board/hooks/register.tsx`, open the pane on the work view at `session.start` when the session is attached
- [X] T030 [US4] Write `plugins/board/skills/root/SKILL.md`: how a root session starts sessions for top-level Items and Responsibilities with a brief, reads the tree for status, messages Coordinators by the names the read gives rather than their workers, and adds an Item before starting a session for work the tree lacks
- [X] T031 [US4] Live check and ship: mark this session as root, start one child, jump to it from its session mark, confirm its breadcrumb and opened work view, then press the root mark to come back; bump the version, commit and push

---

## Phase 6: User Story 2 - Goals and tasks from their trackers (Priority: P4)

**Goal**: Rhythms objectives and key results, Linear projects and issues, and the on-call board appear in the tree, cached and shared.

**Independent Test**: follow one goal and one Linear project linked under one of its key results; confirm both appear with progress and open tasks, and a second session reuses the cache.

### Tests for User Story 2

- [ ] T032 [P] [US2] Write Linear cases in `plugins/board/tests/work-sources.test.ts`: a stubbed `linear issue list --json` answer becomes a Project Item under its configured `under` parent with Task children; state types map per research R8; a second refresh inside the fresh window runs no `linear` command; a failing command keeps the last Items and names Linear on the freshness line
- [ ] T033 [P] [US2] Write Rhythms cases in `plugins/board/tests/work-sources.test.ts`: a stubbed `mcp__rhythms__search_knowledge` answer becomes an Objective with Key result children carrying progress and the configured Kind names; `checkinDue` is the Monday after the last check-in; the board's `tool.check` allows only its own read calls to the listed Rhythms tools and leaves the model's own calls alone
- [ ] T034 [P] [US2] Write `boards` Source cases in `plugins/board/tests/work-sources.test.ts`: the oncall board's items appear as children of the configured local Item, with their section as status

### Implementation for User Story 2

- [ ] T035 [US2] Spike research R1 in a live session: call `mcp__rhythms__search_knowledge` through `$.tool.call` from a `$.clock.every` callback outside a turn; record the result in `specs/001-board-work-model/research.md` R1 and, if it fails, refresh Rhythms only on `turn.start` and when the view is shown
- [ ] T036 [P] [US2] Implement `plugins/board/hooks/work/sources/linear.ts`: one `linear issue list --team <team> --project <name> --all-states --all-assignees --json` per configured project, Items `linear:<identifier>` with the identifier as an alias, the project as a parent Item, `under` applied, Kinds from config, through `readSource` in `plugins/board/hooks/work/cache.ts`
- [ ] T037 [P] [US2] Implement `plugins/board/hooks/work/sources/rhythms.ts`: one `search_knowledge` call with the followed goals' ids and `include_children`, Items `rhythms:<short id>` with progress, status per R8, owner and `checkinDue`; register its `tool.check` hook as a bare statement allowing only the board-origin calls
- [ ] T038 [P] [US2] Implement `plugins/board/hooks/work/sources/boards.ts`: read another configured board's file and place its items under the named local Item, reusing the file reading in `plugins/board/hooks/views/file.tsx`
- [ ] T039 [US2] Live check and ship: add `rhythms`, `linear` and `boards` sources to `~/.config/board/boards.json` (follow OBJ-2346; CRB Funding - Money Movement under its instant-funding key result), confirm one `at` per cache file across two sessions, ask the root session how the work stands against the goals, bump the version, commit and push

**Checkpoint**: goals and tasks arrive without hand copying.

---

## Phase 7: User Story 5 - Deadlines, time spent and periods (Priority: P5)

**Goal**: target dates on lines, active time rolled up from sessions, Period filtering.

**Independent Test**: a task due tomorrow shows yellow, and its parent shows the summed active time of two sessions under it.

- [ ] T040 [P] [US5] Write `plugins/board/tests/work-time.test.ts`: a target inside two hours draws red as a countdown, inside a day yellow; a transcript with prompts and entries yields active time with gaps over 5 minutes cut; a parent sums its sessions' time, finished ones included; `/board work <period>` draws only Items whose dates fall in it, with their ancestors
- [ ] T041 [US5] Compute active time in `sessionInfo` in `plugins/board/hooks/work/harnesses/claude.ts` from `~/.claude/projects/*/<session id>.jsonl` per research R5, caching each result by transcript mtime in `~/.cache/board/time.json`
- [ ] T042 [US5] Draw dates with `dueOf` and time with `span` from `plugins/board/hooks/kit.tsx` in `plugins/board/hooks/work/view.tsx`, and accept a Period name as `/board work <period>` in `plugins/board/hooks/register.tsx`
- [ ] T043 [US5] Live check and ship: bump the version, commit and push

---

## Phase 8: User Story 6 - An inbox for asks (Priority: P6)

**Goal**: asks with no parent wait in an Inbox until placed.

**Independent Test**: an ask with no parent shows in the Inbox with who asked, and moves once placed.

- [ ] T044 [P] [US6] Add Inbox cases to `plugins/board/tests/work-tool.test.ts`: an `add` with `origin.type: "asked"` and no parent draws under Inbox with the requester; an `update` with `parent` moves it out
- [ ] T045 [US6] Place parentless asks in the Inbox group in `buildTree` in `plugins/board/hooks/work/model.ts` and draw the group in `plugins/board/hooks/work/view.tsx`
- [ ] T046 [US6] Live check and ship: bump the version, commit and push

---

## Phase 9: Polish

- [ ] T047 [P] Document the work model in `plugins/board/README.md`: the tree, Kinds, each Source, Host and Harness and its config, the work tool, starting sessions, the root session and its skill, migration; make `plugins/board/.claude-plugin/plugin.json` and its `.claude-plugin/marketplace.json` entry say the same thing (Constitution VII)
- [ ] T048 [P] Remove the `groups` layout from `plugins/board/hooks/views/file.tsx` and its tests in `plugins/board/tests/file-board.test.ts` once no configured board uses it (Constitution I)
- [ ] T049 Run every block in `specs/001-board-work-model/quickstart.md` in a live session and check SC-001 to SC-006

---

## Dependencies & Execution Order

### Phase dependencies

- Setup (T001 to T002) first; Foundational (T003 to T006) blocks every story.
- US1 (Phase 3) is the MVP and comes first: every later story draws into its view. Shipped in 0.2.0.
- US3 (Phase 4) next, then US4 (Phase 5), which needs US3's Sessions and Host.
- US2 and US6 depend only on US1; US5's active time depends on US3's Claude Code Harness.
- Polish last.

### Within each story

Tests first, then Sources and model changes, then the view and tool, then the live check and ship.

### Parallel opportunities

- T017, T018 and T019 together; T021, T022 and T023 together.
- T032, T033 and T034 together; T036, T037 and T038 together.
- US2 and US6 can proceed beside US3 and US4 in a separate session.

## Parallel Example: User Story 3

```text
T017 session tests, T018 tool tests, T019 Artifact tests   # separate describe blocks
T021 herdr.ts, T022 claude.ts, T023 github.ts              # separate files
```

## Implementation Strategy

### Delivery order

US1 (shipped), US3, US4, US2, US5, US6. After US4, one root session can start, track and reach
every other session; US2 then lets it answer how the work stands against the goals.

### Incremental delivery

Each story ends in its own plugin version. Ship, reload the sessions, look at it live, then start
the next story.

## Notes

- Every task that ends a story runs `claude plugin validate`, `tsc` and `claude plugin test` before
  its commit (Constitution, Mod Constraints).
- The validator lets `$` reach only function declarations and wants each atom read in its own file;
  keep each view's atoms in that view's file.
- T026, measured 2026-10-27 on 0.3.0: a started session came up under its Item with its Coordinator and
  message name in about 30 seconds, got its brief, and answered a message by that name. Only 5 of 26
  running sessions attached (SC-003 not met): most of the board's Items carry no aliases, Linear Items
  arrive with US2, and on-call, review and side-project sessions have no Item to sit under yet.
- T031, checked 2026-10-27 on 0.5.0 with throwaway sessions: a root session started a child, the child
  opened its pane on the work view down to its Item, marked "here", under a root mark. 23 of the 26
  sessions running then attached with no hand link; the CRB architecture session's workspace had been
  renamed `crb`, which no alias can match without tying with other CRB sessions.
- The memory note on the work board (`~/.claude/projects/-Users-zamua/memory/work-board.md`) needs
  updating once US3 and US4 ship.
