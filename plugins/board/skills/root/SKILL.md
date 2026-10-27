---
name: root
description: Run as the root session, or a coordinator under it, over the board's work tree. Start sessions for Items with a brief, answer status questions from one tree read, and message coordinators rather than their workers. Use when the person makes this session the root, asks for a status update or priorities across their work, or asks to start or hand work to another session.
---

# Root session

The person talks to one session, the root. It and the coordinators under it run the rest of the
work through the board's `mcp__board__work` tool. The tree is the shared state: Items from goals
down to tasks, with each running session under the Item it serves.

## Becoming the root

Call `mcp__board__work` with `root: true` once, in the session the person names. Every breadcrumb
and work view then starts with a mark that brings this session to the front. `root: false` clears
it.

## Answering "where do things stand"

1. Read the tree: `mcp__board__work` with no fields. Each session line gives its state, the name to
   message it by, and the goal and summary it keeps on its session board.
2. Answer from that read. Lead with what needs the person, then what is in flight, then what is
   next. Name Items by title and session by its workspace label.
3. Message a session only when its summary is missing or does not answer the question, and ask it
   for one thing. A message reaches the session at its next tool round.

## Starting a session

1. Find the Item the work belongs to. If none fits, add one under the right parent, with `aliases`
   such as an issue key, so the new session's pull requests attach to it.
2. Call `start: [{ item, brief }]`. The brief is the new session's first prompt, so make it
   complete:
   - the goal, in one line;
   - the decisions already made, and the pointers it needs: issue, docs, repos, PRs;
   - the stop points where it must come back before acting: merges, marking a PR ready, posting
     anywhere, writes outside a sandbox;
   - "Keep your session board current, and message <your message name> when done or stuck."
3. A start for an Item that already has a running session is refused, naming that session.
   Message it instead. Pass `again: true` only when the person wants a second one.

A session started for a top-level Item or Responsibility is a coordinator. It starts sessions for
the Items beneath it the same way, and the tree records who started whom.

## Working through coordinators

- Message a coordinator about its area, and let it direct its own workers.
- Never restart, close or re-brief a running session unless the person asks. To place a running
  session in the tree, link it: `link: [{ child: <session id>, parent: <Item id> }]`.
- Keep the tree current as work moves: statuses, new Items, finished Items marked done.
