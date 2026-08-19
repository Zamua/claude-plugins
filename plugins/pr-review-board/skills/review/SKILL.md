---
description: Review a GitHub pull request on request, read-only, with findings proven by failing tests and a plain-English report. Use when the user shares a pull request URL and asks for help reviewing it, or asks you to review a PR, a stack, or a set of related PRs. Never posts comments, approvals, or reviews.
---

# Review a pull request

The manual path. Same process as the background reviewer, driven by you in this
session instead of a spawned agent. Use it when the user hands you a pull request
URL rather than reacting to it on GitHub.

**Read `${CLAUDE_PLUGIN_ROOT}/docs/REVIEW-RULES.md` first.** It is the authority on
how the review is conducted and what the report contains. Everything below is
mechanics.

## This is read-only

No comments, no review submissions, no approvals, no change requests, no pushes, no
branch edits. Local writes only: the checkout, the report, scratch tests, hunkt
notes. If the user asks you to post something, give them the text and let them post
it.

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

3. **Show the diff in hunkt**, one tab per pull request, through the layout helper.
   Only do this when running inside a herdr pane; otherwise skip to step 4 and
   review from the diff directly.

   The helper is keyed by a review the poller created, so for a manual review drive
   hunkt directly instead. Write the diff to a file **outside** the checkout and
   watch it, which is what makes it refreshable:

   ```bash
   mkdir -p ~/workspace/reviews/.pr-review-board/manual
   P=~/workspace/reviews/.pr-review-board/manual/<repo>-<number>.patch
   gh pr diff <number> --repo <owner/repo> > "$P"
   # in a herdr tab of its own:
   hunkt patch "$P" --watch
   # then find its id, since a patch session has no repo to select by:
   hunkt session list --json | jq -r '.sessions[] | select(.sourceLabel|endswith("<repo>-<number>.patch")) | .sessionId'
   ```

   To refresh after the pull request moves, rewrite `$P` with the same `gh pr diff`.
   The watched session reloads itself.

   Pass that explicit session id to every `hunkt session` command: a patch session
   exposes no repo, so `--repo` cannot select it. Never call `hunkt session reload`
   on one — it silently replaces the review with a working-tree diff instead of
   erroring.

4. **Review per the review rules.** Prove every behavioral finding with a test in
   the checkout that fails against this code. Drop anything you cannot reproduce.

5. **Produce the outputs.** Inline hunkt annotations on the findings worth steering
   the user to, `REVIEW.md` in the review directory, and a summary in the
   conversation.

6. **Stop and iterate.** Walk the user through it and answer questions. Do not
   start changing code unless they ask.

## If the pull request moves while you are working

Rewrite the patch file and the watched session reloads itself. Notes survive that
reload, but a force-push moves lines underneath them, so re-derive anchors from
`hunkt session review <sid> --json` and re-place them rather than trusting what
survived.
