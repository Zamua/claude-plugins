---
description: Check code against eleven smells (implicit coupling, layer-first folders, duplication, representable illegal states, god files, shotgun surgery, layering violations, pass-through wrappers, validation not at the boundary, change-detector tests, implicit state machines). Use while designing or implementing a change, for a self-review of a diff before committing or opening a PR, when asked to audit a repo, or when the user triggers /clean-code-audit. Every finding needs a path:line.
---

# clean-code-audit

Eleven smells that make a codebase hard to change safely. This is about structure,
not style and not bugs: formatting, naming taste and lint rules are out of scope.
A bug found along the way is reported separately (see "Bugs are not smells").

Three ways to use it:

- **While implementing**: ask the questions in "Before you write it" as the design
  forms, when fixing a smell costs a line instead of a refactor.
- **Self-review of a diff**: check what the diff added or made worse, before the
  commit or the PR. Not the whole repo.
- **Repo audit**: rate all eleven across a codebase, with evidence, and list every
  finding with its fix.

## The eleven smells

For each: what it is, how to find it, what the fix looks like, and what does not count.

### 1. Implicit coupling

Two pieces of code that must agree, with nothing saying so. A magic string or
number written in two places, a wire shape mirrored by hand on the other side of
a boundary, a format one module writes and another parses, "call A before B",
environment variables read deep inside the code.

- **Find it**: grep for the literal (a route, a header name, a status string, a
  limit) and count the files. Look at both sides of every boundary: client and
  server, service and worker, two languages talking over JSON. A comment saying
  "must match X" or "mirrors Y" is a confession.
- **Fix**: one definition everyone imports. Across languages, generate both sides
  from one contract, or pin them with a parity test that fails when they drift.
- **Not it**: a value that merely happens to be equal in two places that are free
  to diverge.

### 2. Layer-first folders

Grouping by technical role (`controllers/`, `services/`, `models/`, `repos/`)
instead of by feature or bounded context, so every feature change touches every
folder.

- **Find it**: pick one feature and list the directories it spans. A feature
  spread across five sibling role folders is the smell.
- **Fix**: group by context first (`orders/`, `billing/`), and layer inside each.
- **Not it**: a small single-context codebase laid out as ports and adapters on
  purpose (`domain/`, `app/`, `adapters/`), with the dependency direction
  enforced. Layers inside one context are fine.

### 3. Duplication

The same non-trivial logic in more than one place, so a fix lands in one copy and
the others stay broken. Watch for copies that have already drifted apart, which
are worse than identical ones.

- **Find it**: identical helper names defined twice (`grep -rn "function isRecord"`),
  the same guard or validation repeated across handlers, two near-twin files.
  Diff suspected twins to measure the overlap.
- **Fix**: extract the shared piece once the second copy exists and the copies
  mean the same thing. Twin modules that differ in a few places usually want a
  shared base with the differences passed in.
- **Not it**: two snippets that look alike but encode different rules that will
  change for different reasons. Test setup repeated for readability.

### 4. Representable illegal states

Types that can hold combinations that must never happen: a `status` next to
nullable fields that are only valid in some statuses, several booleans that are
mutually exclusive, optional fields that are required in one state, an id that is
a bare string mixable with every other id.

- **Find it**: non-null assertions (`!`, `as`, forced unwraps) on fields the type
  calls optional; runtime "invariant checkers" that validate a struct's own
  shape; sentinel values (`""`, `0`, a zero time) meaning "not set" or "unknown";
  a `kind` field with fields that only apply to some kinds.
- **Fix**: a discriminated union, enum or separate type per state, so the bad
  combination cannot be constructed. Branded or newtype ids. Make the compiler
  hold the invariant instead of a validator.
- **Not it**: a nullable field that is genuinely optional in every state.

### 5. God files

One file or class that does many unrelated things, so everything imports it and
every change risks everything.

- **Find it**: `wc -l` the non-generated sources and read the largest. Count the
  concerns, not the lines: a 700-line file with one aggregate is fine; a 400-line
  file holding routing, crypto, persistence and test seeds is not.
- **Fix**: split along the concerns already visible in its section comments.
- **Not it**: a long but cohesive file (one parser, one state machine, one
  stylesheet split by screen). Generated code.

### 6. Shotgun surgery

One conceptual change that needs small edits scattered across many files: adding
a field, a message kind, a question type, a route.

- **Find it**: pick a realistic change ("add one field to the main entity", "add
  one new command") and list every file it would touch. Grep for an existing
  field of the same kind and count its non-test files.
- **Fix**: usually a symptom of 1, 3 or 4. Derive the lists (columns, codecs,
  allow-lists, docs) from one definition, or let the compiler force exhaustive
  handling so a missed site fails to build.
- **Not it**: a change that legitimately crosses layers once each (domain type,
  storage column, API field) with the compiler pointing at every site.

### 7. Layering violations

A layer reaching past its neighbour: UI or handler code touching storage, domain
code importing HTTP, a framework, or a vendor SDK, use cases returning transport
details (status codes, headers, template names), cross-cutting concerns
(caching, metrics, logging, retries) inlined into domain logic.

- **Find it**: read the imports of the domain and use-case layers. Look for
  vendor names, `Response`, status codes, `fetch`, `os`/`fs` calls, and metric or
  cache calls inside business methods.
- **Fix**: the domain depends on a narrow port; adapters own vendor detail;
  cross-cutting concerns wrap the use case as decorators or middleware at the
  composition root. A test that fails on a forbidden import keeps it fixed.
- **Not it**: the composition root and adapters, whose job is to know concrete
  things.

### 8. Pass-through wrappers

Functions or classes that forward to another with the same arguments and add no
meaning: indirection without abstraction.

- **Find it**: bodies that are one call with the same parameters, op tables of
  `(x) => this.y(x)`, interface methods implemented as stubs only to satisfy a
  port, aliases of other functions.
- **Fix**: call the target directly, or make the wrapper earn its place (a
  translation, a narrower type, a policy).
- **Not it**: an adapter that translates between two models, or a port method
  whose implementation happens to be short today.

### 9. Errors and validation not at the boundary

Untrusted input (a request body, a file, a third-party response, a config file)
should be parsed once where it enters, into types the rest of the code can trust.
The smell is input that stays `unknown`, `any` or a raw dict and is re-checked
field by field deep inside, validators that exist but are never called, casts
like `as T` on parsed JSON, and errors swallowed where nothing can handle them.

- **Find it**: follow one request from the edge to storage and note every
  `Number(...)`, cast, `?? default` and null check on the way. Grep for
  `catch` blocks that drop the error, and for validation functions with no
  non-test callers.
- **Fix**: parse, don't validate: one parser per input at the edge producing a
  typed value, and use cases that accept only the typed value. Errors propagate
  to a layer that can act on them, or are handled with a comment saying why.
- **Not it**: a deliberate, commented fail-open at a well-chosen spot. The domain
  enforcing its own invariants (that is the domain's job, not duplicate
  validation).

### 10. Change-detector tests

A test that fails whenever the implementation changes, even when the behaviour did
not. It restates the code instead of checking what the code is for, so it goes red
on every refactor and almost never on a bug, and people learn to update it without
reading it. Then a red test stops meaning anything.

- **Find it**: mocks or spies asserting exact calls, call counts or call order on
  collaborators no caller can observe; a test that mirrors the function under test
  step by step; snapshots or golden files of incidental output (field order,
  whitespace, formatting, generated ids, timestamps) that no consumer depends on;
  assertions on private fields, internal helpers or intermediate state; tests that
  are rewritten, not extended, in every commit that refactors the code they cover
  (`git log --follow` on both files).
- **Fix**: assert the outcome through the public API: the return value, the
  stored result read back through its port, the response a client receives. Prefer
  a fake that holds state over a mock that verifies calls. Pin only what a caller,
  a user or stored data depends on.
- **Not it**: pinning a real contract. A wire format or stored row that other code
  or older clients read; a call to an external system when the call is the
  behaviour (a payment sent once with this idempotency key, a notification sent);
  golden output whose exact form is the product (a rendered document, a CLI's
  documented output). Characterization tests written before a refactor are fine
  when they pin observable behaviour, and become change detectors only when they
  pin internals.

### 11. Implicit state machines

Something with a lifecycle (a session, a job, a connection, a sync loop, a retry
policy, a game round, an order) whose states and transitions are never written
down. The real state is a combination of flags, nullables, counters and
timestamps, and the transitions are `if` checks scattered across whichever
handlers, timers and callbacks happen to run. Nothing answers "what states exist,
and what can happen next from here", so an illegal move (a retry while paused, a
second spawn while one is starting, a claim on a released device) is prevented
only by a guard one handler has and its sibling lacks.

- **Find it**: an entity with two or more of: a `status` or `phase` string,
  booleans like `pending`, `spawning`, `isOpen`, nullable `...At` or `...Until`
  timestamps, attempt counters, sentinels (`""`, `0`, a past time) meaning "not
  yet". Then grep for writes to those fields: the same fields assigned in several
  handlers, or `if (a && !b)` guards repeated with small differences, are the
  smell. Also timers and callbacks that change state without checking the
  current one, tests that set the fields directly to reach a state instead of
  sending events, and a comment describing the lifecycle in prose that no code
  enforces.
- **Fix**: name the states as a union, one variant per state carrying only that
  state's data, and write one pure transition function, `next(state, event)`,
  returning the new state and the effects to run. It is the only place the state
  changes. Every state and event pair is decided: handled, ignored with a reason,
  or rejected, with an exhaustive switch so a new state or event fails to compile
  until it is handled. Timers, I/O and sends live in a thin shell that performs
  the returned effects. Test by feeding event sequences, legal and illegal, and
  asserting the states and effects that come out.
- **Not it**: a single boolean with no other state attached. A lifecycle already
  owned by one explicit transition point, whatever it is called (a reducer, an
  actor's message handler, a workflow engine's steps). Smell 4 covers the shape of
  the data; this one covers who may change it and when. The two are usually fixed
  together.

## Before you write it

The cheap moment to avoid all eleven is before the code exists. While designing a
change, answer these:

1. Where does untrusted input enter, and what typed value does it become there?
2. Can the new type hold a state that must never happen? What union removes it?
3. Am I writing a literal that something else must also know? Where does it live
   once?
4. Is there already a helper that does this? Am I about to copy one?
5. How many files does this change touch, and would the next change like it touch
   the same number? If so, centralise first, then make the change.
6. Does any domain or use-case code now import a framework, vendor, or transport
   type, or call a cache, metric or logger inline?
7. Does the file I am adding to already do several unrelated things?
8. Would the test I am writing still pass after a refactor that keeps the
   behaviour? If not, it pins the implementation.
9. Does this thing have a lifecycle? Where is the one place its state changes,
   and what happens to an event that does not fit the current state?

## Self-review of a diff

Run through the eleven against the diff, not the codebase. Report only what the
diff introduces or worsens; a pre-existing smell the diff touches gets one line
at most, and is not a reason to grow the change. Fix what is cheap now. Anything
deferred gets named in the PR or the commit summary, never silently left.

## Repo audit

1. Read the repo's own docs first (CLAUDE.md, README, architecture notes). Judge
   against the eleven and against the design the repo says it follows. Drift from
   its own stated design is a finding.
2. Skip generated and vendored code, build output, lockfiles and fixtures.
3. Rate each smell: **clean**, **minor**, **notable**, **severe**. Clean is a
   valid and welcome rating; do not pad.
4. Every claim carries a `path:line` or a path plus a measurement. No evidence, no
   claim.
5. End with the complete list of findings, most severe first, each with its
   concrete fix in one line. No top-N cut: every finding that holds up is listed,
   and a short list is the right answer for clean code.
6. Verify the top findings yourself before reporting them, especially when a
   subagent did the audit: open the file and confirm the line says what the
   finding claims.

Report shape, one line per smell:

```
REPO <name> (<language>, <approx source lines>)
1. Implicit coupling: notable - <evidence, path:line>
...
9. Errors/validation at the boundary: minor - <evidence>
10. Change-detector tests: clean
11. Implicit state machines: notable - <evidence>
Findings, most severe first:
1. <smell number> <path:line>: <the problem>. Fix: <one line>
```

For several repos, one read-only subagent per repo works well; give each the list
above and the evidence rule, and keep the reports short.

## Bugs are not smells

An audit often turns up real defects: a validator nobody calls, a handler wired to
a dependency that is always null, a value computed in one place and ignored in
another. Report those first and separately from the ratings, mark which ones you
confirmed by reading the code, and treat them with the urgency of a bug rather
than a refactor.
