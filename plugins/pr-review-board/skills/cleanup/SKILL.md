---
description: Tear down ONE finished pr-review-board review - close its herdr workspace, remove its worktrees, delete its directory and report, and mark it terminal. Runs as soon as the user asks, with no confirmation step. Scoped to a single review: if you are a review worker, the only one you may ever touch is your own assignment. Use when the user asks to clean up a review, is done with a review, or asks what reviews are still open.
---

# pr-review-board — cleanup

Teardown is manual and it is the operator's call. Nothing about a review expires on
its own, and taking the reaction off a pull request does not reap anything by itself.
The reaction is the trigger, not a switch.

The operator asking for cleanup is the whole approval. Do not show a plan and wait,
and do not ask whether they are sure. Resolve the review, tear it down, and report
what was removed.

Nothing survives. The report, the comment list, and any scratch tests are deleted
with the review directory. The comments that were posted on GitHub are the lasting
record.

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
hard rule 3 of your persona. When they ask, run this against your own key straight
away and against nothing else.

**If you are the operator's session**, you may tear down any review, but only the one
they named.

```bash
C="${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.sh"
```

## Steps

1. **Resolve the review.** A worker uses the `key` from its assignment. The
   operator's session passes whatever the user named: a key, a slug,
   `owner/repo#N`, or a pull request url.

   If the user did not name one, run `"$C" list`, show it, and ask which. That is the
   one question this skill asks, because guessing could tear down a review another
   agent is still working. `list` prints every open review on the machine, and seeing
   one there is not a reason to touch it.

2. **Apply.** `"$C" apply <key> --yes`

   In order: mark the review `CLEANEDUP`, remove each worktree, delete the review
   directory and its metadata, close the herdr workspace.

   The mark lands before anything is destroyed and the workspace close comes last, on
   purpose. Closing a workspace takes every pane in it, so a run from inside the
   review's own workspace would kill itself. Apply refuses that one close and tells you
   to run `herdr workspace close <ws>` yourself, so the teardown still finishes. If it
   dies for any other reason partway, the review is already terminal, and re-running
   apply on the same key picks up what is left.

3. **Remove the trigger reaction** from every pull request the review covered, so a
   torn-down review stops reading as one in progress. Do this after apply succeeds,
   not before, or a failed teardown leaves the pull request unmarked.

   Only the pull requests this review covered, taken from your assignment or from
   `"$C" plan <key>` run before apply. A reaction on any other pull request stays where
   it is: it is very likely another review's live trigger, and pulling it would strand
   that review.

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

4. **Tell the user what was removed**, which reactions came off, and, when apply left
   the workspace open because you are running in it, the `herdr workspace close`
   command to finish with.

## What it will not do

- Touch another review. Every command takes one key, and nothing here iterates over
  the reviews root or the state store.
- Touch a canonical clone. Only worktrees the review created are removed, and the
  owning clone is read from git rather than guessed from a path.
- Delete anything outside the configured reviews root. It refuses and says so.
- Resurrect afterwards. `CLEANEDUP` is terminal, so the poller ignores that review
  forever. Re-reviewing a pull request needs a genuinely new reaction, and since
  step 3 already cleared the old one, adding the emoji back is the whole gesture. It
  arrives with a current timestamp and opens a fresh review.

## If a worktree will not go

Apply logs it and carries on rather than aborting half-done. Remove it by hand and
say so in the report back:

```bash
git -C <canonical-clone> worktree remove --force <path>
git -C <canonical-clone> worktree prune
```
