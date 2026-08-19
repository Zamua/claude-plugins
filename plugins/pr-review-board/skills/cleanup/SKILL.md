---
description: Tear down a finished pr-review-board review - archive its report, close its herdr workspace and report pane, remove its worktrees, delete its directory, and mark it terminal. Use when the user asks to clean up a review, is done with a review, or asks what reviews are still open.
---

# pr-review-board — cleanup

Teardown is manual and it is the operator's call. Nothing about a review expires on
its own, and removing the reaction from the pull request does not reap anything.

```bash
C="${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.sh"
```

## Steps

1. **List what is open.** `"$C" list`

   If the user did not name a review, show them this and ask which one. Do not
   guess, and never tear down more than they asked for.

2. **Plan it.** `"$C" plan <key|slug|owner/repo#N|pull-request-url>`

   This writes nothing. It prints the review, its pull requests, and every action
   that would be taken. Show the user this output.

3. **Confirm.** Get an explicit yes for that specific review. This step is not
   optional: apply removes worktrees and deletes a directory, and the only thing it
   preserves is the report.

4. **Apply.** `"$C" apply <key> --yes`

   In order: archive `REVIEW.md` to `<reviews-root>/.archive/<slug>.md`, close the
   herdr workspace, remove each worktree, delete the review directory, mark the
   review `CLEANEDUP`.

5. **Tell the user where the report went**, since that is the one artifact that
   survives.

## What it will not do

- Touch a canonical clone. Only worktrees the review created are removed, and the
  owning clone is read from git rather than guessed from a path.
- Delete anything outside the configured reviews root. It refuses and says so.
- Run without `--yes`. It refuses and points at `plan`.
- Resurrect afterwards. `CLEANEDUP` is terminal, so the poller ignores that review
  forever. Re-reviewing the same pull request needs a genuinely new reaction:
  remove the emoji and add it again, which gives it a current timestamp and opens a
  fresh review alongside the kept record.

## If a worktree will not go

Apply logs it and carries on rather than aborting half-done. That usually means the
worktree has uncommitted scratch tests. Check with the user whether they want the
evidence, then remove it by hand:

```bash
git -C <canonical-clone> worktree remove --force <path>
git -C <canonical-clone> worktree prune
```
