---
description: Tear down ONE finished pr-review-board review - archive its report, close its herdr workspace and report pane, remove its worktrees, delete its directory, and mark it terminal. Scoped to a single review: if you are a review worker, the only one you may ever touch is your own assignment. Use when the user asks to clean up a review, is done with a review, or asks what reviews are still open.
---

# pr-review-board — cleanup

Teardown is manual and it is the operator's call. Nothing about a review expires on
its own, and taking the reaction off a pull request does not reap anything by itself.
The reaction is the trigger, not a switch.

## Scope: one review, and only the one you were pointed at

Reviews run several at a time and share a reviews root, a herdr session, and a state
store. Everything here takes a single review key and touches nothing else.

**If you are a review worker**, meaning you have an assignment file, then the only
review in your scope is the one in that assignment, and the only pull requests in
your scope are the ones it lists. Another review's directory, workspace, worktrees,
report, or pull request is never yours to clean up, however finished it looks and
however plainly it shows up in `list`. Read your assignment for the key rather than
inferring one from a path or a slug that resembles yours.

You also do not decide that your own review is over. That call is the operator's, per
hard rule 3 of your persona. If they ask you directly, you may run this against your
own key and nothing else.

**If you are the operator's session**, you may tear down any review, but only the one
they named, one at a time, and only after they confirm that specific review.

```bash
C="${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.sh"
```

## Steps

1. **List what is open.** `"$C" list`

   This prints every open review on the machine, including reviews other agents are
   still working. Seeing one is not a reason to touch it. Use the list to resolve the
   review you were pointed at, nothing more.

   If the user did not name a review, show them this and ask which one. Do not
   guess, and never tear down more than they asked for.

2. **Plan it.** `"$C" plan <key|slug|owner/repo#N|pull-request-url>`

   This writes nothing. It prints the review, its pull requests, and every action
   that would be taken. Show the user this output.

3. **Confirm.** Get an explicit yes for that specific review. This step is not
   optional: apply removes worktrees and deletes a directory, and the only thing it
   preserves is the report. Say that you will also take the reaction off each pull
   request, since `plan` does not list that step.

4. **Apply.** `"$C" apply <key> --yes`

   In order: archive `REVIEW.md` to `<reviews-root>/.archive/<slug>.md`, mark the
   review `CLEANEDUP`, remove each worktree, delete the review directory and its
   metadata, close the herdr workspace.

   The mark lands before anything is destroyed and the workspace close comes last, on
   purpose. Closing a workspace takes every pane in it, so a run from inside the
   review's own workspace kills itself. Apply refuses that one close and tells you to
   run `herdr workspace close <ws>` yourself, so the teardown still finishes. If it
   dies for any other reason partway, the review is already terminal, and re-running
   apply on the same key picks up what is left.

5. **Remove the trigger reaction** from every pull request the review covered, so a
   torn-down review stops reading as one in progress. Do this after apply succeeds,
   not before, or a failed teardown leaves the pull request unmarked.

   Only the pull requests this review covered, taken from `plan` output or your own
   assignment. A reaction on any other pull request stays where it is: it is very
   likely another review's live trigger, and pulling it would strand that review.

   The reaction lives on the pull request body, which the API treats as an issue.
   Match the configured reaction and your own login, since other people and bots
   react to the same pull requests:

   ```bash
   R=$(jq -r '.reaction // "EYES" | ascii_downcase' "${PR_REVIEW_BOARD_CONFIG:-$HOME/.config/pr-review-board/config.json}")
   ME=$(gh api /user --jq .login)
   for pr in <owner/repo#N ...>; do
     repo="${pr%%#*}"; num="${pr##*#}"
     id=$(gh api "/repos/$repo/issues/$num/reactions" \
       --jq ".[] | select(.content==\"$R\" and .user.login==\"$ME\") | .id")
     [ -n "$id" ] && gh api --method DELETE "/repos/$repo/issues/$num/reactions/$id"
   done
   ```

   No id means it is already gone, which is fine and not worth reporting. A failure
   here does not undo the teardown: say which pull request still carries the
   reaction and move on.

6. **Tell the user where the report went**, since that is the one artifact that
   survives, and which reactions you removed.

## What it will not do

- Touch another review. Every command takes one key, and nothing here iterates over
  the reviews root or the state store.
- Touch a canonical clone. Only worktrees the review created are removed, and the
  owning clone is read from git rather than guessed from a path.
- Delete anything outside the configured reviews root. It refuses and says so.
- Run without `--yes`. It refuses and points at `plan`.
- Resurrect afterwards. `CLEANEDUP` is terminal, so the poller ignores that review
  forever. Re-reviewing a pull request needs a genuinely new reaction, and since
  step 5 already cleared the old one, adding the emoji back is the whole gesture. It
  arrives with a current timestamp and opens a fresh review alongside the kept
  record.

## If a worktree will not go

Apply logs it and carries on rather than aborting half-done. That usually means the
worktree has uncommitted scratch tests. Check with the user whether they want the
evidence, then remove it by hand:

```bash
git -C <canonical-clone> worktree remove --force <path>
git -C <canonical-clone> worktree prune
```
