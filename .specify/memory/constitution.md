<!--
Sync Impact Report
- Version change: template → 1.0.0 (first ratification)
- Principles added: I. Simplest Design That Keeps 90%; II. Read Models, Not New Systems of
  Record; III. Domain-Neutral Core, Specifics at the Edges; IV. Shared Budgets Are Respected;
  V. Glanceable UI; VI. Tests Prove Behavior at the Boundary; VII. Docs Match What Ships
- Sections added: Mod Constraints, Development Workflow, Governance
- Removed sections: none
- Templates:
  - ✅ .specify/templates/plan-template.md: its Constitution Check reads gates from this file;
    no edit needed
  - ✅ .specify/templates/spec-template.md: no mandatory sections added or removed
  - ✅ .specify/templates/tasks-template.md: its optional test tasks fit Principle VI
  - ✅ CLAUDE.md and README.md: Principle VII restates CLAUDE.md's README rule; no edit needed
- Deferred: none
-->

# claude-plugins Constitution

## Core Principles

### I. Simplest Design That Keeps 90%

A design that keeps 90% or more of the value with clearly less machinery MUST win. Plugins MUST
NOT add wrapper layers, speculative options or adapters no current user needs. A general core is
allowed; generic machinery nobody uses is not.

Rationale: these plugins have one or a few users, and every layer is code the owner maintains alone.

### II. Read Models, Not New Systems of Record

A plugin MUST show data that lives elsewhere, such as GitHub, Linear, Rhythms, herdr or a file
another process writes, by reading it from there. It MUST store locally only what has no other
home. Each external system MUST be reached through one adapter that translates it into the
plugin's own language, so the rest of the plugin never sees that system's terms.

Rationale: a second copy of someone else's data drifts, and the drift is invisible.

### III. Domain-Neutral Core, Specifics at the Edges

A plugin's core model MUST NOT name a field, company or tool. Names and rules such as OKRs, Linear
projects or on-call belong in adapters and in user configuration.

Rationale: the same plugin must serve an engineer, an academic or a maintainer without a fork.

### IV. Shared Budgets Are Respected

External APIs are shared by every session and agent on the machine. A plugin calling one MUST batch
its requests, MUST share what it fetched with other sessions through a cache, MUST poll only while a
session is in use, and MUST stop asking before a rate limit is reached, not after.

Rationale: one runaway poller once exhausted the GitHub budget for every session on the machine.

### V. Glanceable UI

A pane MUST read at a glance: one line per item, quiet chrome, the data's freshness in the top
right, and detail behind a press. Anything the person needs to act on MUST be visible without
scrolling or pressing.

Rationale: a pane sits beside the conversation; it is read in a second, not studied.

### VI. Tests Prove Behavior at the Boundary

Tests MUST use the mod test kit and assert what the person sees or what a tool returns. Tests MUST
NOT be tautological or mirror the implementation, and MUST mock only what is external or
nondeterministic, such as `gh`, the clock or the file system.

Rationale: a test that fails on a refactor that keeps behavior is a cost, not a guard.

### VII. Docs Match What Ships

`README.md` MUST list every plugin in `.claude-plugin/marketplace.json`, in manifest order. A
plugin's `plugin.json` description MUST agree with its manifest entry. Code comments MUST explain
only a why the code cannot show.

Rationale: nothing fails when a doc drifts, so the drift goes unnoticed.

## Mod Constraints

- Each plugin lives in `plugins/<name>/` and loads one hooks module named in `hooks/hooks.json`.
- `claude plugin validate <plugin>` MUST pass, `tsc` MUST be clean against the plugin's
  `.claude-plugin/types`, and `claude plugin test <plugin>` MUST pass before a change ships.
- A UI change MUST also be checked in a live session, since the test kit accepts trees the
  terminal draws differently.

## Development Workflow

- Changes go straight to `main` with single-line messages: `feat(<plugin>): …` or
  `fix(<plugin>): …`. Specs do not get feature branches; spec-kit's branch hook is off.
- Every change bumps the plugin's version in `plugin.json`. It reaches Claude Code through
  `claude plugin marketplace update` and `claude plugin update <plugin>@zamua`, then
  `/reload-plugins` in each session.
- A spec lives in `specs/<###-name>/` and is written with spec-kit before a plugin's model changes.

## Governance

This constitution supersedes conflicting practice in this repository. The owner, Zamua, amends it.
Each amendment bumps the version: MAJOR for a removed or redefined principle, MINOR for a new
principle or section, PATCH for wording. Every plan's Constitution Check MUST name any principle it
breaks and justify it in the plan's Complexity Tracking table.

**Version**: 1.0.0 | **Ratified**: 2026-10-27 | **Last Amended**: 2026-10-27
