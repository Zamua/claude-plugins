# Review rules

The single source of truth for how a pull request review is conducted here. Both
paths use this file: the background worker the poller spawns
(`agents/pr-reviewer.md`) and the manual `/pr-review-board:review <url>` skill.
Change the process here, not in two places.

## Read-only, always

A review never writes to GitHub. No comments, no review submissions, no
approvals, no change requests, no pushes, no branch or label edits, and nothing
posted to Slack. The only writes are local: the review checkouts, the report,
scratch tests, and hunkt notes.

This holds even when the finding is urgent and even when asked to "just leave a
quick comment". Posting is the operator's job. Say what you would post and let
them post it.

## Process

1. **Check the code out locally** under the review directory, one worktree per
   pull request. Clone the canonical repo first if it is missing. The code must be
   buildable and testable, not just readable.
2. **Read everything.** The full diff, the pull request description, every comment
   and review thread including bot reviews, and the commit history. Read the
   changed files whole, not just the diff hunks. For a stack, read the layers
   below for context even when they are not in scope.
3. **Prove every behavioral finding with a failing test.** For anything that looks
   like a business logic bug, a correctness bug, or similar, write a unit or
   integration test in the review checkout that fails against the pull request's
   code and reproduces the bug. If the test passes, or the behavior cannot be
   reproduced and you are no longer convinced it is a bug, **drop the finding**.
   Never report an unproven behavioral claim.
4. **Note the rest plainly.** Findings that cannot be proven this way, such as
   naming, structure, missing docs, convention drift, or a risk you cannot
   trigger, are written down as observations with no test.
5. **Report in simple terms.** Assume the reader is not an expert in the
   subsystem. Say what breaks and why it matters before any code detail.
6. **Stop and wait.** The review ends with the report, not with changes. Iterate on
   the findings with the operator until they understand and agree. Do not start
   editing the reviewed code unless they ask.

Tests written during a review are scratch evidence. They stay in the review
checkout, untracked, unless the operator asks for them. Never commit them, and never
push the checkout.

## Report shape

In this order:

1. **What this change is about.** The problem being solved, in plain English, with
   enough background that someone unfamiliar with the subsystem follows it. Name
   the concepts before using them.
2. **How it tries to fix it.** The approach, briefly.
3. **Risk and blast radius.** Its own section, leading with a one-line verdict of
   low, medium, or high, then the reasoning. Cover:
   - Existing paths versus net-new code. Which live code paths change behavior,
     and which additions are unreachable until something else calls them. Name the
     callers and entry points you actually traced. If a shared helper or interface
     changed, list every caller.
   - Gating. Is it behind a feature flag, a config value, or an env var, and what
     is the default on merge. Say whether merging alone changes production
     behavior.
   - Who is affected if it is wrong. Every user, one customer, an internal
     dashboard, a nightly job, or nobody until a flag flips.
   - Irreversible or stateful surfaces. Money movement, third-party API calls,
     schema migrations, backfills, queue or event contract changes, anything that
     writes data you cannot unwrite.
   - Any domain-specific lenses the operator's own instructions add to this list.
   - Reversibility. Flag flip, revert and redeploy, or manual data repair.
   - Cross-repo coupling. Other repos or services that must deploy in a specific
     order.
4. **Findings**, worst first. Each one says what breaks, why it matters, where it
   is, and either the failing test that proves it or an explicit note that it is
   unproven.
5. **Grouping note**, when the review covers more than one pull request: which
   pull requests are in scope and why they were grouped.

Do not guess at risk. Base every claim on code you read or a caller search you
ran, and say plainly when you cannot tell. Unknown is not low.

## Writing style

Plain English, short declarative sentences. No em-dashes. Explain the issue before
explaining the fix. Define domain terms on first use. A reader who has never seen
this subsystem should finish the first two sections knowing what the change does
and why it exists.
