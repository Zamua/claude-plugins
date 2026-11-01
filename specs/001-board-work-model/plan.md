# Implementation Plan: Board Work Model

**Branch**: `main` (no feature branch) | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/001-board-work-model/spec.md`

## Summary

The board's `work` view becomes a tree of Items built in memory from five Sources: the local file
(Responsibilities, side projects, asks, hand links), Rhythms (goals), Linear (projects and tasks),
the prs boards (pull requests). Sessions come from a Host (herdr first) and a Harness (Claude Code
first). Each Source, Host and Harness is one adapter that maps its system into the core types; the
core names no tool, multiplexer or agent runtime. Sessions and pull requests attach to Items by
identifiers already in their names, and Claude edits the local file through a new
`mcp__board__work` tool, which can also start a Session for an Item through the Host. Delivery
follows the spec's six stories, each shippable alone.

## Technical Context

**Language/Version**: TypeScript with JSX, run by the Claude Code mod engine (2.1.311)
**Primary Dependencies**: the mod API (`$` engine interface, atoms, `ui.render`); CLIs `linear`,
`herdr`, `gh`; the Rhythms MCP server through `$.tool.call`
**Storage**: the local file (`~/workspace/work-board/board.json`, format version 2); shared caches
in `~/.cache/board/`; per-session fold state in module memory
**Testing**: `claude plugin test` with the mod test kit; `tests/engine.ts` stubs `fs`,
`process.run`, `tool.call` and the clock
**Target Platform**: Claude Code terminal panes on macOS, inside herdr
**Project Type**: Claude Code mod (one plugin, `plugins/board`)
**Performance Goals**: building and drawing a 200-Item tree under 100 ms; no refresh blocks a turn
**Constraints**: GitHub and Rhythms budgets shared machine-wide (Constitution IV); the validator's
`$` rules (function declarations only, atoms read in their own file)
**Scale/Scope**: one person; about 200 Items, 25 Sessions, 50 Artifacts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| I. Simplest design at 90% | Five adapters, each one the first user needs; no Kind editor, no write-back beyond starting a Session, no new GitHub calls; coordination is a skill, not code | Pass |
| II. Read models | External Items are read and cached, never copied into the local file; the file holds only what has no other home | Pass |
| III. Domain-neutral core | `work/model.ts` names no tool; Kind names come from config; ids, states and aliases are mapped in adapters | Pass |
| IV. Shared budgets | Rhythms hourly and Linear every 10 minutes through shared caches, only from sessions in use; GitHub through the existing cache with no new calls | Pass |
| V. Glanceable UI | One line per Item, folded to the top level, needs counts on top lines, freshness top right | Pass |
| VI. Tests at the boundary | Tests assert drawn lines and tool results; only CLIs, MCP calls, files and the clock are stubbed | Pass |
| VII. Docs match | README's board section and `plugin.json` description updated with the work model | Pass |

Re-check after Phase 1 design: still passes. One risk is recorded rather than a violation: if
`$.tool.call` cannot reach an MCP tool outside a turn (research R1), Rhythms refreshes only on turns
and on opening the view, which keeps Principle IV and adds no machinery.

## Project Structure

### Documentation (this feature)

```text
specs/001-board-work-model/
├── plan.md              # this file
├── research.md          # Phase 0: decisions R1 to R11
├── data-model.md        # Phase 1: Item, Status, Session, Artifact, Link, Period, tree
├── quickstart.md        # Phase 1: how to see each story work
├── contracts/
│   ├── config.md        # boards.json `model` layout
│   ├── local-file.md    # format version 2 and the migration from version 1
│   ├── work-tool.md     # mcp__board__work
│   └── source-adapter.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
plugins/board/
├── hooks/
│   ├── register.tsx             # adds the work view and the work tool's hooks
│   ├── kit.tsx                  # shared drawing helpers, unchanged API
│   ├── views/
│   │   ├── file.tsx             # stays for the oncall board and other file boards
│   │   ├── session.tsx          # gains the breadcrumb and root mark (story 4)
│   │   ├── prs.tsx              # unchanged; its cache feeds the github Source
│   │   └── review.tsx           # unchanged
│   └── work/
│       ├── model.ts             # core types, tree build, rollup, alias matching; no `$`, no tool names
│       ├── board.ts             # the configured board: its file, tree, Period, refresh
│       ├── view.tsx             # the work view: fold state, head, breadcrumb, Period list
│       ├── lines.tsx            # one line per Item, Session, Artifact and placed board
│       ├── tool.tsx             # mcp__board__work: validation and file writes
│       ├── migrate.ts           # version 1 to version 2
│       ├── sources/
│       │   ├── file.ts          # the local file
│       │   ├── rhythms.ts       # goals through $.tool.call, shared cache
│       │   ├── linear.ts        # projects and issues through the linear CLI, shared cache
│       │   ├── github.ts        # Artifacts from prs boards and the GitHub cache
│       │   └── boards.ts        # another file board's items under a local Item
│       ├── hosts/
│       │   └── herdr.ts         # Host: lists, starts and focuses sessions; takes over focusWorkspace
│       └── harnesses/
│           └── claude.ts        # Harness: active time, last activity, message name, launch command
├── skills/
│   └── root/SKILL.md            # how a root session starts, briefs and checks on other sessions
└── tests/
    ├── work-model.test.ts       # tree, rollup, matching, cycles, through the view and tool
    ├── work-migrate.test.ts
    ├── work-sources.test.ts     # each adapter against stubbed CLIs and MCP answers
    └── work-session.test.ts     # attach, start, Coordinators, breadcrumb, root
```

**Structure Decision**: the work model lives in `hooks/work/`, beside the existing `views/`, so the
core (`model.ts`) and the adapters (`sources/`) are separate files and the validator's
per-file atom rule keeps each atom with its reader. The file board view stays for boards that are
not the work model, such as oncall.

## Delivery order

Each step ships as its own plugin version and is checked live before the next:

1. Story 1: model, local file Source, migration, work view, work tool. Shipped in 0.2.0.
2. Story 3: the Host and Harness ports with herdr and Claude Code, the github Source, alias
   matching, hand links, Coordinators, the session mark that focuses a session, starting a Session
   for an Item, and session summaries in the tree read.
3. Story 4: breadcrumb, the root session and its mark, the work view opened down to the current
   session, and the root-session skill.
4. Story 2: Linear, then Rhythms (after the R1 spike), then the `boards` Source for on-call.
5. Story 5: dates on lines, active time, Periods.
6. Story 6: Inbox.

Stories 3 and 4 come before Story 2 because together they let one root session start, track and
reach every other session.

## Complexity Tracking

No violations to justify.
