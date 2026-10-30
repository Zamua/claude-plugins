# pr-review-board — design

One persistent operator session plus N ephemeral review agents, each bound to one
changeset. The trigger, the review, and the artifacts all live where the code does.
Nothing runs in the cloud, and the only things that reach GitHub are the comments the
operator picked by number and the approvals the operator asked for.

## Goals

- A one-gesture trigger on the object being reviewed: react to a pull request, get a
  review. No channel to scope, no token to mint, no issue to file.
- A review that stays current. Pull requests move, so the diff and the board are
  refreshed rather than regenerated.
- Findings that are true. A behavioral claim ships with a test that fails against the
  reviewed code, or it does not ship.
- A one-way gate on GitHub. An agent reads freely and writes only the comments the
  operator approved by number and the approvals the operator asked for, so the
  blast radius of a runaway agent is its own directory.
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

**herdr 0.9.5.** `agent start` attaches to an existing pane already at a shell
prompt and derives the executable from `--kind`, so a launch is three calls:
`workspace create`, `agent start`, `agent prompt`. A fresh pane answers
`agent_pane_busy` until its shell is up, so that one error is retried and no other is.
Inside a pane the injected socket already points at the right server, so `--session`
is passed only from outside one.

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
clones, never diffs. `poll.sh once` is the whole scheduled unit.

**Review agent.** One per review. Owns everything object-level: clones, worktrees,
tests, the board, and the monitor loop. It reads GitHub freely, writes nothing there
until the operator names comment numbers or says to approve, and cannot tear itself
down.

**Operator.** Reacts to pull requests, reads reports, asks questions, approves the
comments that get posted, decides which pull requests get approved, and is the only
actor that tears a review down or otherwise acts on a finding.

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

- **chain** — its base is a member's head, or its head is a member's base, in the
  same repo and never through the default branch, or a release pull request would
  link every review whose members target it
- **tracker id** — its branch carries the same id as a member's, matched only at the
  start of the branch or right after a `/`

Otherwise it opens its own review. A review that grows past one pull request is
promoted to an umbrella directory named for the pull request that opened it. The
review **key** never changes, because pull request bindings point at it; only the slug,
directory, and workspace label do. The herdr agent name is therefore assigned once and
read back from state forever after — recomputing it from a promoted slug would orphan
the live agent and leave the review permanently `stopped`.

### Scope is the agent's

Grouping only decides which reactions share a review. The harness does not decide
what a review covers, because whether a change can be judged from the pull requests
reacted to is a reading of the code, not of branch names. The agent owns it, through
two commands:

- `poll.sh stack <pr>` lists every open pull request in the pull request's stack,
  bottom first, by walking base and head branches down to the default branch and up
  through every child. It reads branches rather than `gh stack view`, which needs the
  stack tracked in a local clone and misses chains other tools built.
- `poll.sh adopt <key> <pr>...` adds pull requests to the agent's own live review,
  through the same join path a reaction takes, so promotion to an umbrella and the
  assignment rewrite behave identically. It refuses a pull request another live
  review covers, so two agents never share a checkout or a comment list.

The agent always adopts the whole stack. Anything beyond that is its judgement, and
the report's grouping note says what it added and why.

## Layout

One herdr tab per review, labelled with the slug, holding one pane: the review agent.
With `herdr_workspace` set, every review's tab sits in that one workspace, so reviews
gather in one place in the herdr sidebar; otherwise each tab has a workspace of its
own. Teardown closes the tab, or the review's own workspace. Nothing is opened per pull request, because the report already covers every
pull request in scope and the set can grow while the review is live. The review
itself is one file, `board.json` in the review's metadata directory, and the board
plugin's review view draws it beside the agent. The agent prints the headline and the
comment numbers in its own pane, never the comment text.

The board carries the navigation instead. Each pull request in scope is linked at the
top, and each finding links to the file at the reviewed head sha and to the scratch
test that proves it, so reading the board is how the operator reaches the code.

One file rather than a report and a comment list keeps the wording the operator reads
and the wording that posts the same: `board.sh payload` builds each review from the
board, and `board.sh mark` records the post on it, so the pane and the ledger cannot
disagree. The pane finds the board through `state.json`, by the session the poller
recorded for the review or the herdr workspace it runs in, or for a review run by
hand by a path keyed with the session's id.

## Directories

- Single pull request: `<reviews_root>/<repo>-<number>/`, which is also the worktree.
- Several: an umbrella `<reviews_root>/<slug>-<anchor>/` with one worktree per pull
  request inside.

Scratch tests sit untracked inside a checkout, which is correct: a review checkout is
evidence, not a branch being prepared. They are deliberately **not** hidden with an
exclude file, because a linked worktree has no per-worktree `info/exclude` — git
honours only the shared one, so hiding them would mean editing the operator's
canonical clone. The board and everything the harness writes live in the metadata
directory instead, so `git status` in a checkout only ever shows the reviewer's
scratch tests.

## State

`~/.config/pr-review-board/state.json`, with `last_poll`, a `reviews` map keyed by
review, and a `pr_index` so a pull request belongs to at most one live review. Every
mutation goes through a temp file, so a crash mid-write cannot truncate the store.

Per-review data lives in `<reviews_root>/.pr-review-board/<key>/`: the assignment,
the worker's copy of the review rules, the cached diffs, and the board. That location
is deliberately **outside** the review directory, because for a single-pull-request
review the review directory *is* a git worktree, and `git worktree add` accepts an
existing empty directory but refuses a non-empty one. Keeping metadata out means the
checkout starts empty, nothing pollutes `git status` but scratch tests, and promotion
to an umbrella is a plain `git worktree move`.

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
same decision as a first launch and goes through the same loop. Claude writes a
session's transcript on its first message, so a launch counts only once its kickoff
prompt lands, and a saved session with no transcript is spawned fresh, not resumed.

## Safety

- A review writes to GitHub only on the operator's word: the comments they picked by
  number, and an approval of each pull request they named. Change requests, pushes,
  and merges are never the agent's. That is stated in the persona, in the shared
  review rules, and in the kickoff prompt. `board.sh` builds every post from the
  board and refuses a comment already posted.
- Teardown runs when the operator asks, with no second confirmation, and keeps
  nothing: the board goes with the metadata directory and scratch tests with the
  review directory. The script itself refuses without `--yes`, refuses to delete
  outside the reviews root, and reads a worktree's owning clone from git rather than
  guessing.
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
