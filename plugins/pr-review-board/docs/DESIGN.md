# pr-review-board — design

One persistent operator session plus N ephemeral review agents, each bound to one
changeset. The trigger, the review, and the artifacts all live where the code does.
Nothing runs in the cloud, and the only thing that reaches GitHub is a comment the
operator picked by number.

## Goals

- A one-gesture trigger on the object being reviewed: react to a pull request, get a
  review. No channel to scope, no token to mint, no issue to file.
- A review that stays current. Pull requests move, so the diff, the annotations, and
  the report are refreshed rather than regenerated.
- Findings that are true. A behavioral claim ships with a test that fails against the
  reviewed code, or it does not ship.
- A one-way gate on GitHub. An agent reads freely and writes only the comments the
  operator approved by number, so the blast radius of a runaway agent is its own
  directory.
- Teardown that is always the operator's decision.

## Verified tool behaviour

These were established empirically against the installed versions. They are the
reason the design looks the way it does.

**GitHub reactions (GraphQL).** There is no reverse lookup for "things the viewer
reacted to", so eligibility is a candidate scan plus a per-candidate check. Narrowing
with `reactions:>0` and matching each reaction's author against the viewer keeps a
whole pass at **1 rate-limit point per page**, and one page holds 100 pull requests.
The cost is logged per page rather than assumed. Reaction nodes
carry `createdAt`, which is what makes a freshness window possible without any stored
watermark. `baseRefName` arrives in the same query, so stack detection is free.
Filtering on the viewer is essential: bots react to pull requests constantly, and a
bot 👀 is indistinguishable from a human one by count alone.

**nvim 0.12.4.** The review pane is `nvim -R -M -n -p` on `REVIEW.md` and
`COMMENTS.md`, one tab each, and nvim does not notice the agent rewriting either. A
`vim.uv` timer calling `checktime` every two seconds is what makes the pane live, and
without it the operator reads a stale report with nothing to indicate it. `-M` does not
interfere: a nomodifiable buffer still reloads, because a reload is not an edit.
checktime does defer a reload for a buffer with no window, so the inactive tab is also
re-checked on `TabEnter`.

The lockdown is deliberate. Both buffers are views of the agent's output, so an edit
could only collide with the next rewrite. The cursor stays visible: nvim re-asserts
DECTCEM show on every redraw, `guicursor` has no hidden shape, and highlight `blend` is
inert in the TUI, so hiding it is not available at any price worth paying.
`vim.diagnostic.enable(false)` is global rather than per-buffer, so it also covers
language servers that attach after startup.

**herdr 0.7.5.** `agent start` attaches to an existing pane already at a shell
prompt and derives the executable from `--kind`, so a launch is three calls:
`workspace create`, `agent start`, `agent prompt`. A fresh pane answers
`agent_pane_busy` until its shell is up, so that one error is retried and no other is.
Inside a pane the injected socket already points at the right server, so `--session`
is passed only from outside one.

`pane split` takes no command, so the report pane is a split followed by a `pane run`.
That `run` reports success as soon as the API accepts the keystrokes, including when
the shell had not reached its prompt and dropped them, so the only proof nvim launched
is `pane wait-output --match NORMAL`. Checking before each retry rather than after is
deliberate: a blind second `run` gets typed into an nvim that did start.

**Claude Code permissions.** A read outside the agent's cwd raises a prompt that a
background worker has nobody to answer, so the cwd is the reviews **root** and
everything the agent needs — assignment, a copy of the review rules, every checkout —
lives under it. `bypassPermissions` and `--dangerously-skip-permissions` are both
dead ends here: each is gated behind a one-time interactive acceptance screen, so the
worker exits within seconds instead of starting. An explicit `acceptEdits` is also
worse than passing nothing, being more restrictive than a default `auto` mode for
outside-cwd reads. Passing no permission flag at all is correct.

**GitHub search index lag.** `reactions:>0` is an indexed qualifier, so a reaction is
not immediately visible to the candidate scan — observed at several seconds. The
freshness window absorbs it: the reaction stays eligible for the whole window, so the
next pass picks it up. This is why the trigger tolerates a slow index without any
retry logic.

## Roles

**Poller.** Deliberately thin. It decides which pull requests the operator asked for,
groups them into reviews, writes the assignment, and brings an agent up. It never
clones, never diffs, never builds layout. `poll.sh once` is the whole scheduled unit.

**Review agent.** One per review. Owns everything object-level: clones, worktrees,
the report pane, tests, the report, the proposed comment list, and the
monitor loop. It reads GitHub freely, writes nothing there until the operator names
comment numbers, and cannot tear itself down.

**Operator.** Reacts to pull requests, reads reports, asks questions, approves the
comments that get posted, and is the only actor that tears a review down or otherwise
acts on a finding.

## Trigger

A pull request is eligible when the viewer added the configured reaction to its body
at or after the cutoff:

```
cutoff = min(now - spawn_window_seconds, last_successful_poll)
```

Equivalently the window is `max(configured, time since the last successful pass)`. The
floor stops a historical reaction from ever spawning. The widening stops a slept-through
reaction from being dropped. A failed scan leaves the watermark alone, so an outage
delays reviews instead of losing them. With no recorded pass, day one uses the flat
floor and ignores all history.

Reactions on comments are not triggers. The gesture is on the pull request itself.

## Grouping

Sequential, oldest reaction first, with each new review immediately visible to the
rest of the pass. That makes intra-batch grouping fall out of the same rule as
joining an existing review, so there is no connected-components pass and no
coalescing timer.

A fresh pull request joins an **ACTIVE** review when either holds:

- **chain** — its base is a member's head, or its head is a member's base
- **tracker id** — its branch carries the same id as a member's, matched only at the
  start of the branch or right after a `/`

Otherwise it opens its own review. A review that grows past one pull request is
promoted to an umbrella directory named for the pull request that opened it. The
review **key** never changes, because pull request bindings point at it; only the slug,
directory, and workspace label do. The herdr agent name is therefore assigned once and
read back from state forever after — recomputing it from a promoted slug would orphan
the live agent and leave the review permanently `stopped`.

## Layout

One herdr workspace per review, labelled with the slug. Tab 1 holds the review agent,
and the agent splits its own pane to the right for the review documents. That is the
whole layout: the agent on the left, `REVIEW.md` and `COMMENTS.md` as two nvim tabs on
the right, and nothing per pull request,
because the report already covers every pull request in scope and the set can grow
while the review is live.

The report carries the navigation instead. Each pull request in scope is linked at the
top, and each finding location links to the file at the reviewed head sha, so reading
the report is how the operator reaches the code.

## Directories

- Single pull request: `<reviews_root>/<repo>-<number>/`, which is also the worktree.
- Several: an umbrella `<reviews_root>/<slug>-<anchor>/` with one worktree per pull
  request inside, and the report at the umbrella root.

The report and any scratch tests sit untracked inside a checkout, which is correct:
a review checkout is evidence, not a branch being prepared. They are deliberately
**not** hidden with an exclude file, because a linked worktree has no per-worktree
`info/exclude` — git honours only the shared one, so hiding them would mean editing
the operator's canonical clone. Everything the harness itself writes lives in the
metadata directory instead, so `git status` in a checkout only ever shows the
reviewer's own work.

## State

`~/.config/pr-review-board/state.json`, with `last_poll`, a `reviews` map keyed by
review, and a `pr_index` so a pull request belongs to at most one live review. Every
mutation goes through a temp file, so a crash mid-write cannot truncate the store.

Per-review harness data lives in `<reviews_root>/.pr-review-board/<key>/`: the
assignment, the cached diffs, and the report pane id. That location is
deliberately **outside** the review directory, because for a single-pull-request
review the review directory *is* a git worktree, and `git worktree add` accepts an
existing empty directory but refuses a non-empty one. Keeping metadata out means the
checkout starts empty, nothing pollutes `git status` but the report, and promotion to
an umbrella is a plain `git worktree move`.

The assignment is rewritten in full on every scope change, so the agent always reads
the current picture rather than replaying a diff.

`status` is `ACTIVE` or `CLEANEDUP`. `CLEANEDUP` is terminal and the record is kept, so
`status` still explains where a pull request went. A new reaction on a cleaned-up pull
request opens a fresh review under a new key rather than reviving the old one.

## Concurrency

`cap` bounds concurrent reviews; the rest wait for the next pass. A `mkdir` lock makes
a pass single-flight, and a lock left by a dead pass is reclaimed. Review identity is
the herdr agent name, so a pass that overlaps a launch adopts rather than duplicates.
An `ACTIVE` review whose agent died is resumed with `claude --resume`, which is the
same decision as a first launch and goes through the same loop.

## Safety

- A review never writes to GitHub. That is stated in the persona, in the shared review
  rules, and in the kickoff prompt.
- Teardown refuses without `--yes`, refuses to delete outside the reviews root, reads
  a worktree's owning clone from git rather than guessing, and archives the report
  before removing anything.
- Canonical clones are only ever fetched from and worktree'd; their branches and
  working trees are left alone.
- Only reactions by the configured viewer count, so nobody else can dispatch an agent
  on the operator's machine.

## Build and rollout

1. Local build, `claude plugin validate`, load with `--plugin-dir`.
2. Dry run with `"runtime": "stub"`: `poll.sh fresh` and `poll.sh once` exercise the
   trigger, grouping and assignment without launching anything.
3. One real review end to end at `cap: 1`, driven by `poll.sh spawn <pr>`.
4. Arm the scheduler with `poll.sh install`, and only after step 3 looked right.
