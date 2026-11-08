# Clean-code smells

## The fourteen smells

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
  cache calls inside business methods. Read use-case signatures too: framework
  paging, ORM or query-builder types in them, and use cases that read the caller's
  identity, the request or the session from ambient context (a global, a
  request-scoped store, a framework helper) instead of taking it as a parameter.
- **Fix**: the domain depends on a narrow port; adapters own vendor detail;
  cross-cutting concerns wrap the use case as decorators or middleware at the
  composition root. The entry point resolves the caller and passes it in; the
  port returns the app's own result type (a page of items, not the framework's
  page object). A test that fails on a forbidden import keeps it fixed.
- **Not it**: the composition root and adapters, whose job is to know concrete
  things. An application service that opens a transaction or declares caching
  with the framework's own primitive, with no wrapper of ours around it: the
  import ban is for the domain layer, not the use cases.

### 8. Shallow modules

A module whose interface is about as complex as what it hides, so callers pay
for the abstraction and are spared no work. A deep module has a small interface
over a lot of behaviour; a shallow one exposes nearly every decision it makes.
The extreme case is a pass-through wrapper: a function or class that forwards
to another with the same arguments and adds no meaning. Other forms: a class
whose public methods mirror its private steps one for one; a feature split into
many small classes that every caller must build and wire in the right order; an
interface that leaks its internals, so callers must know the call sequence, the
defaults or the intermediate types to use it; parameters that push onto every
caller a decision the module could make itself.

- **Find it**: compare each module's interface with its body. Count what a
  caller must know (public methods, parameters, types, call order) against the
  decisions hidden behind it. Look for bodies that are one call with the same
  parameters, op tables of `(x) => this.y(x)`, interface methods implemented as
  stubs only to satisfy a port, aliases of other functions; callers that repeat
  the same multi-call setup around the module (with smell 1's "call A before
  B"); arguments every caller computes the same way; a helper or test library
  whose every use carries the same boilerplate.
- **Fix**: deepen it. Fold the steps every caller repeats into the module, pick
  defaults so the common case needs no configuration, hide intermediate types,
  and merge classes that are always used together. Delete a pass-through and call
  the target directly, or make it earn its place (a translation, a narrower type,
  a policy).
- **Not it**: an adapter that translates between two models; a port method whose
  implementation happens to be short today; a small function whose name states a
  rule its body only computes, which hides a decision and is deep for its size;
  modules split out of a god file (smell 5) that each hide something of their
  own.

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

### 12. Unnecessary sequential async calls

Independent awaits run one after another (`await a(); await b()`), or an `await`
sits inside a loop, so the latency is the sum of the calls instead of the longest.
It matters on hot paths: request handlers, boot and startup, polling loops, and
fan-outs over sessions, rows or files.

- **Find it**: go through each `await` and ask "does the next call use this
  result, or depend on its side effect?" If neither, they can overlap. Grep for
  `await` inside `for`, `while`, `.forEach` and `.map` bodies, and for runs of
  adjacent awaits on storage, RPC, file or HTTP calls (the same shape in other
  languages: sequential `.get()`s, an N+1 query loop). Read request handlers and
  boot paths first. Wall time near the sum of the call times confirms it.
- **Fix**: start the independent calls, then await them together (`Promise.all`,
  `asyncio.gather`, an errgroup). For a loop over N items, a bounded-concurrency
  pool, or one batched query or RPC (`WHERE id IN (...)`, a bulk get) instead of N.
- **Safety rules**:
  - Keep the order where the order is the contract: delivery sequencing, writes to
    one store or row, transaction and ledger ordering, any step with a side effect
    the next one relies on, calls under a rate limit.
  - Error semantics change. `Promise.all` rejects on the first failure and the
    rest keep running unobserved; use `allSettled` when partial results matter or
    each failure needs its own handling.
  - Cap the concurrency. An unbounded fan-out over N items exhausts connections
    and file handles or trips rate limits.
  - Every fix needs a test that pins the ordering-sensitive cases: order kept where
    it is the contract, results returned in input order, one failure handled as
    before, the cap holding.
- **Not it**: sequential on purpose (the comment says why), a cold path that runs
  once, a call that needs the previous result, awaits already overlapped.

### 13. Whole-row loads

Loading a full row or object (`SELECT *`, a whole document, a whole file, a full
session record) when the caller uses a few of its fields. It costs bandwidth,
memory and parse time, drags large columns along, and ties the caller to the
whole shape.

- **Find it**: `SELECT *` or a get-by-id followed by reading one or two fields; a
  `list()` whose callers only count, test for existence or map to a name; rows
  loaded for an existence check that carry big text, JSON or blob columns; a whole
  file read to get its size or its head; any of these inside a loop (with 12). For
  each load, list the fields the caller reads. A small subset is the smell. Poll
  loops, list views, per-request lookups and boot paths first.
- **Fix**: project only the needed columns or fields. Give the question its own
  narrow port method (`exists`, `count`, `nameOf`, `idsFor`) instead of loading the
  entity and discarding it. Keep large columns out of hot reads. Read a head or
  tail slice, not the whole file.
- **Safety rules**:
  - The narrow read must give the same answer: check the dropped fields are not
    read later, for example by a mapper that validates the whole row or a default
    filled from a dropped column.
  - One definition of the shape: a projection type derived from the entity, not a
    hand-copied partial that drifts (smells 1, 3).
  - Do not narrow a read-modify-write, or a read whose fields must come from one
    snapshot with the rest of a transaction; it needs the full state it changes.
  - The narrow method belongs on the port, not in the caller (smell 7).
  - Every fix needs a test that the narrow read returns what the full load would
    for the fields used, using a fixture whose unrelated large or invalid column
    would break or slow a full load.
- **Not it**: a caller that really uses most of the object, a small row where every
  field is used, a cache that is meant to hold the whole entity.

### 14. Behaviour away from its data

A rule that depends only on one object's own fields, living somewhere else: a
service, handler or helper takes the object and reads its fields to work out
something about it (an order's total, whether a subscription is active, when a
card is next due). The type shrinks to a bag of fields, the rule is re-derived at
each call site, and a change to the type breaks code far from it.

- **Find it**: functions whose only domain parameter is one object and whose body
  only reads that object's fields; the same derivation from the same fields in
  two places (grep the field names, and see smell 3); services doing arithmetic
  or status checks on a type whose own module defines nothing but its shape.
- **Fix**: move the rule into the domain module next to the type, as a method or
  a pure function exported beside it, and have callers ask the object instead of
  reading its fields. The application service keeps the orchestration: loading,
  saving, calling other contexts.
- **Not it**: logic that needs other aggregates, I/O or configuration, which
  belongs in the application service (or takes those as parameters); plain data
  shapes at a boundary (DTOs, wire types) that are meant to carry no behaviour; a
  projection computed for one view.

## Before you write it

The cheap moment to avoid all fourteen is before the code exists. While designing a
change, answer these:

1. Where does untrusted input enter, and what typed value does it become there?
2. Can the new type hold a state that must never happen? What union removes it?
3. Am I writing a literal that something else must also know? Where does it live
   once?
4. Is there already a helper that does this? Am I about to copy one?
5. How many files does this change touch, and would the next change like it touch
   the same number? If so, centralise first, then make the change.
6. Does any domain code now import a framework, vendor, or transport type? Does
   a use case take a framework type in its signature, read the caller from
   ambient context instead of a parameter, or call a cache, metric or logger
   inline?
7. Does the file I am adding to already do several unrelated things?
8. Would the test I am writing still pass after a refactor that keeps the
   behaviour? If not, it pins the implementation.
9. Does this thing have a lifecycle? Where is the one place its state changes,
   and what happens to an event that does not fit the current state?
10. Do these awaits depend on each other? If not, do they run together, and with a
    cap when it is a loop? Where the order is the contract, is that said?
11. Does this read fetch only the fields the caller uses, or a whole row for two of
    them?
12. Does this rule read only one object's own fields? Then it lives next to that
    object's type, not in the service that calls it.
13. Does this module's interface hide more than it exposes? Will every caller
    repeat the same steps or arguments around it?
