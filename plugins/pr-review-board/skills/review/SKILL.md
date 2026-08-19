---
description: Review a GitHub pull request on request, with findings proven by failing tests and a plain-English report, then propose a numbered list of comments and post the ones the user picks. Use when the user shares a pull request URL and asks for help reviewing it, or asks you to review a PR, a stack, or a set of related PRs. Never approves, requests changes, or pushes.
---

# Review a pull request

The manual path. Same process as the background reviewer, driven by you in this
session instead of a spawned agent. Use it when the user hands you a pull request
URL rather than reacting to it on GitHub.

**Read `${CLAUDE_PLUGIN_ROOT}/docs/REVIEW-RULES.md` first.** It is the authority on
how the review is conducted and what the report contains. Everything below is
mechanics.

## The GitHub boundary

Nothing reaches GitHub until the user approves comments by number. Local writes only
until then: the checkout, the report, the comment list, and scratch tests.
Once they pick numbers you post those comments and nothing else. Approvals, change
requests, pushes, branch and label edits, marking a draft ready, and merging are
always theirs. See the GitHub boundary in the review rules.

## Steps

1. **Work out the scope.** One pull request, or several. A stack counts as several.
   Check the base branch: a base that is not the repository default branch means the
   pull request sits on another one. When there is a stack, invoke the `gh-stack`
   skill and use `gh stack view --json`. Review the layers you were given and read
   the ones below for context.

2. **Check out under the reviews root.**
   - Single pull request: `~/workspace/reviews/<repo>-<number>/`
   - Several: an umbrella `~/workspace/reviews/<short-slug>-<anchor-number>/` with
     one checkout per pull request inside as `<repo>-<number>/`

   Clone the canonical repo into `~/workspace/<repo>` first if it is missing, then
   add a detached worktree for the pull request head. `git worktree add` accepts an
   existing empty directory and refuses a non-empty one, so do not write anything
   into the target first. Never disturb an existing clone's branches or working tree
   beyond fetching.

3. **Open the report pane.** Only when running inside a herdr pane; otherwise skip
   to step 4 and let the user open `REVIEW.md` however they like.

   The layout helper is keyed by a review the poller created, so a manual review
   drives it directly. Seed both files first, since nvim cannot reload into one that
   does not exist yet:

   ```bash
   D=~/workspace/reviews/<repo>-<number>
   printf '# Review in progress\n' > "$D/REVIEW.md"
   printf '# Proposed comments\n\nNone yet.\n' > "$D/COMMENTS.md"
   herdr pane split --pane "$HERDR_PANE_ID" --direction right --ratio 0.5 --cwd "$D"
   # then, in the pane id that came back:
   herdr pane run <pane> "nvim -R -M -n -p \
     -c 'luafile ${CLAUDE_PLUGIN_ROOT}/scripts/report-view.lua' \
     $D/REVIEW.md $D/COMMENTS.md"
   ```

   `-p` gives one tab per file. `-R -M -n` makes both buffers unmodifiable and
   unwritable, and `report-view.lua` turns diagnostics off and polls both files, so the
   user watches them fill in as you write.

   `herdr pane run` reports success even when the shell was not ready and dropped the
   command, so confirm with
   `herdr pane wait-output <pane> --match NORMAL --source visible --timeout 3000`
   before assuming nvim is up, and never fire the command twice blind. The second copy
   gets typed into a live nvim.

4. **Review per the review rules.** Prove every behavioral finding with a test in
   the checkout that fails against this code. Drop anything you cannot reproduce.

5. **Produce the outputs.** `REVIEW.md` in the review directory, every pull request
   and finding location linked, a summary in the conversation, and `COMMENTS.md`
   holding the proposed comment list. Write both in whole states, since the user is
   reading them live in the pane.

6. **Propose the comments.** Print the numbered list in the conversation and stop.
   Walk the user through the findings, answer questions, and reword entries as they
   ask, keeping each number fixed. Do not start changing the reviewed code unless
   they ask.

7. **Post the numbers they pick.** Re-check the head SHA first, then one batched
   review per pull request, then report the urls against their numbers. The proposed
   comments section of the review rules carries the call and the failure modes.

## If the pull request moves while you are working

Re-run `gh pr diff` and re-read it. The pane picks up your rewritten `REVIEW.md` on
its own. Re-derive the finding links, since they pin a head sha and a force-push
leaves them pointing at code that is no longer there.
