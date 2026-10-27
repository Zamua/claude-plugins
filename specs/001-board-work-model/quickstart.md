# Quickstart: Board Work Model

How to see each story work once it is built. Each block stands alone.

## Story 1: the tree from the local file

1. Back up and migrate: `/board work migrate`. It saves `board.v1.json`, rewrites `board.json` as
   version 2 and prints counts before and after.
2. `/board work`. Expect one line per top-level Item, Outcomes first, then Responsibilities, each
   with its "needs you" count, and the freshness in the top right.
3. Press a line; its children open beneath it. Press again; they fold.

## Story 2: goals and tasks from their trackers

1. In `boards.json`, add `sources.rhythms.follow: ["OBJ-2346"]` and a `sources.linear` project
   with `under` set to one of that goal's key results.
2. `/reload-plugins`, then `/board work`. Expect the objective, its key results with progress, and
   the project's open tasks under the chosen key result.
3. Open the work view in a second session; `~/.cache/board/rhythms.json` keeps one `at` time.

## Story 3: sessions and pull requests

1. Open a herdr workspace whose label contains a task id, such as `mm-809-crb-gross-funding`.
2. Expect the session under MM-809 with its herdr status, and any pull request titled `MM-809 …`
   beside it.
3. In a coordinating session, ask Claude to attach it to the project. Expect the coordinator under
   the project, with the task sessions listed once linked to it.
4. From the coordinator, ask Claude to start a session for another task with a short brief. Expect a
   new workspace labeled after the task, the session under the task at once with the coordinator as
   its Coordinator, and the brief as its first prompt. Ask again and expect a refusal naming it.
5. Ask the coordinator for a status update. Expect it to answer from one tree read, with each
   session's goal and summary.

## Story 4: breadcrumb and the root

1. In the session you talk to, ask Claude to make it the root session.
2. Press a task's session mark in the work view. In the session that comes up, `/board session`.
   Expect one line such as `⌂ › Objective › Key result › Project › MM-809 › this session` above the
   session board, and its work view opened down to the session, marked.
3. Press the root mark. Expect the root session to come to the front.

## Story 5: deadlines, time, periods

Give a task `target` tomorrow; expect its date in yellow. Expect a parent's line to show the summed
active time of the sessions under it. `/board work Q4 2026-27` filters to that Period.

## Story 6: inbox

Ask Claude to add an ask from someone with no parent. Expect it under Inbox with who asked; ask
Claude to place it and expect it to move.

## Checks before shipping any story

```
claude plugin validate plugins/board
tsc -p plugins/board
claude plugin test plugins/board
```

Then look at the view in a live session (Constitution, Mod Constraints).
