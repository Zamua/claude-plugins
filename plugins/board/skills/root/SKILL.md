---
name: root
description: Run as the root session, or as a session that coordinates others, over the board's work tree. Sort new asks into the tree, start sessions for Items with a brief, rank what needs the person, and answer status, rollup and ETA questions from one tree read. Use when the person makes this session the root, asks where things stand, what needs them, for priorities, a rollup or ETAs, or asks to start or hand work to another session.
---

# Root session

The person talks to one session, the root. The root sorts new work into the tree, starts sessions
for it and reports back. It does little of the work itself: anything that takes more than a few
minutes or touches a repository goes to a session of its own, so the root stays quick to answer.

The tree, read and changed through `mcp__board__work`, is the shared state: Items from goals down
to tasks, each running session under the Item it serves, with its state, the name to message it
by, and the goal and summary from its session board. The root keeps nothing the tree does not, so
a fresh session that becomes the root and reads the tree carries on where the last one stopped.

## Becoming the root

Call `mcp__board__work` with `root: true` once, in the session the person names. Every breadcrumb
and work view then starts with a mark that brings this session to the front. `root: false` clears
it.

## The person works with any session directly

The person may talk to any session without going through the root, and often will, so that design
back-and-forth does not pass through two or three sessions on its way. So:

- Read where a session stands from the tree and its session board, never from what you last told
  it. It may have changed course on the person's word.
- A report you did not ask for is normal. Fold it into the tree.
- Never re-brief a session to undo what the person told it.
- When the person wants to shape a session's work, point them at it rather than relaying. Relay
  only short answers, such as "go with the second option".

## What needs the person

Rank it, most pressing first:

1. Interrupts, such as an incident or an alert.
2. Anything blocking someone else: an ask from a person, a review requested of them, a session
   idle on their decision.
3. Anything due within a day.
4. Planned work under their goals.
5. The routine work of their Responsibilities.
6. Work they started for themselves.

Within a rank, the nearer target goes first. The person's own order wins over this one.

## Answering where things stand

1. Read the tree: `mcp__board__work` with no fields.
2. Lead with what needs the person, ranked as above, then what is in flight, waiting and next.
   For a rollup, go branch by branch, with the progress a Source gives. For one Item, answer from
   its sessions' summaries and its pull requests. Name Items by title and sessions by label.
3. Message a session only when its summary is stale or does not answer the question, and ask it
   one thing. Ask the session that coordinates a branch rather than the workers under it.
4. Take message names from the read you just made. A name changes when its session restarts, so
   never reuse one from memory or from a brief.

## ETAs

Each line of a read gives an Item's target and ETA, and says late when the ETA falls after the
target; a parent carries the latest ETA beneath it. Every session keeps the ETA of the Item it
works current, `update: [{ id, eta }]`, which any Item takes whatever its Source. When ETAs a
question needs are missing or stale, ask the sessions working those Items, then answer.

## Starting a session

1. Find the Item the work belongs to. If none fits, add one under the right parent, with
   `aliases` such as an issue key, so the new session and its pull requests attach to it.
2. Call `start: [{ item, brief }]`. The Host opens it where the person's config places that
   branch of the tree. The brief is the new session's first prompt, so make it complete:
   - the goal, in one line;
   - the decisions already made, and the pointers it needs: issues, documents, repositories,
     pull requests;
   - its stop points: a step that needs the person, a way forward that is unclear, and anything
     published outside as the person, such as a message, a comment, marking a pull request ready
     or a merge. Between them it works on its own judgment;
   - "The person may talk to you directly; follow them. Keep your session board and your Item's
     ETA current, and message <your message name> when done or stuck."
3. A start for an Item that already has a running session is refused, naming that session.
   Message it instead. Pass `again: true` only when the person wants a second one.
4. `model` runs the session on another model than the configured one, such as a lighter one for
   routine passes.

A session whose Item splits into parallel parts starts sessions for them the same way and
coordinates them; the tree records who started whom.

## Working on judgment

The root and every session it starts keep going on their own judgment, unless a step needs the
person, the way forward is unclear, or it would publish something as the person. Keep to the
preferences the person states as they come up.

## Intake

When the person's instructions name the places new asks arrive, start one intake session for
them, under a Responsibility such as Intake, with `model` set to a lighter one. Its brief names
each source, how to notify the person, and to run `/loop 5m /board:intake`. It adds new asks to
the Inbox and messages the root only when something arrives. On such a message, place each ask
or leave it in the Inbox, and tell the person what came in.

## Keeping the tree current

- Never restart, close or re-brief a running session unless the person asks. To place a running
  session in the tree, link it: `link: [{ child: <session id>, parent: <Item id> }]`.
- Keep statuses current, add Items as work appears, and mark finished ones done. Close finished
  sessions only when the person asks.
