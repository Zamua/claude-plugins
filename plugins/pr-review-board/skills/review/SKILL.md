---
description: Review a GitHub pull request on request, with findings proven by failing tests and the whole review written to a board shown beside the session, then propose numbered comments and post the ones the user picks. Use when the user shares a pull request URL and asks for help reviewing it, or asks you to review a PR, a stack, or a set of related PRs. Never approves, requests changes, or pushes.
---

# Review a pull request

The manual path. Same process as the background reviewer, driven by you in this
session instead of a spawned agent. Use it when the user hands you a pull request
URL rather than reacting to it on GitHub.

**Read `${CLAUDE_PLUGIN_ROOT}/docs/REVIEW-RULES.md` first.** It is the authority on
how the review is conducted and what the board contains. Everything below is
mechanics.

## The GitHub boundary

Nothing reaches GitHub until the user approves comments by number. Local writes only
until then: the checkout, the board, and scratch tests.
Once they pick numbers you post those comments and nothing else. Approvals, change
requests, pushes, branch and label edits, marking a draft ready, and merging are
always theirs. See the GitHub boundary in the review rules.

## Steps

1. **Work out the scope.** Start from the pull requests you were given; what the
   review covers is your judgement, per the scope section of the review rules. A
   pull request in a stack brings the whole stack, every open layer reviewed in
   full. List it from the branches for each pull request you were given:
   `${CLAUDE_PLUGIN_ROOT}/scripts/poll.sh stack <owner/repo#N>` prints every open
   layer, bottom first. It needs no `gh stack` command; if you run one anyway,
   invoke the `gh-stack` skill first.

2. **Check out under the reviews root.**
   - Single pull request: `~/workspace/reviews/<repo>-<number>/`
   - Several: an umbrella `~/workspace/reviews/<short-slug>-<anchor-number>/` with
     one checkout per pull request inside as `<repo>-<number>/`

   Clone the canonical repo into `~/workspace/<repo>` first if it is missing, then
   add a detached worktree for the pull request head. `git worktree add` accepts an
   existing empty directory and refuses a non-empty one, so do not write anything
   into the target first. Never disturb an existing clone's branches or working tree
   beyond fetching.

3. **Review per the review rules.** Prove every behavioral finding with a test in
   the checkout that fails against this code. Drop anything you cannot reproduce.

4. **Write the board.** The report and every proposed comment go in one file, per
   the board section of the review rules, at
   `<reviews_root>/.pr-review-board/manual-${CLAUDE_SESSION_ID}/board.json`, where
   `<reviews_root>` is `reviews_root` in `~/.config/pr-review-board/config.json`,
   `~/workspace/reviews` by default. The `/reviewboard` pane finds it by this
   session's id and opens it beside the conversation. Run
   `${CLAUDE_PLUGIN_ROOT}/scripts/board.sh check <board.json>` after every write.
   In the conversation, give the verdict, the blast radius in one line, and the
   comments by number with a few words each.

5. **Propose the comments.** Name the numbers that are ready and stop. Walk the user
   through the findings, answer questions, and reword entries on the board as they
   ask, keeping each number fixed and saying which numbers changed. Never paste a
   comment's body into the conversation; the board shows it. Do not start changing
   the reviewed code unless they ask.

6. **Post the numbers they pick.** Re-check the head SHA first, then one batched
   review per pull request built with `board.sh payload`, then `board.sh mark` each
   number posted with its url. The proposed comments section of the review rules
   carries the calls and the failure modes.

## If the pull request moves while you are working

Re-run `gh pr diff` and re-read it. Re-derive the links on the board, since they pin a
head sha and a force-push leaves them pointing at code that is no longer there.

## When the user is done

Nothing tracks a review run by hand, so delete its board's folder, the
`manual-${CLAUDE_SESSION_ID}` directory, along with its checkouts when the user asks
you to clean up.
