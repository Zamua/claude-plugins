---
name: intake
description: Run one intake pass over the board's work tree. Check the sources the brief names for new asks addressed to the person, add each new one to the tree, and tell the root only when something arrived. Use in an intake session the root started, on a loop such as `/loop 5m /board:intake`.
---

# Intake pass

1. Read the tree with `mcp__board__work`. Each ask's line ends with its link, which is how you tell
   whether the tree already holds one.
2. Check each source your brief names for asks addressed to the person since your last pass, such
   as mentions, direct messages, review requests, items assigned to them and check-ins due. Only
   read: never reply, react, or mark anything read.
3. For each ask the tree does not hold yet, add an Item: a short title, kind Task, `origin` asked
   by whoever asked, a link to it, a `target` when it carries a deadline, and the parent it plainly
   belongs under, or none so it waits in the Inbox.
4. If you added anything, message the root once, one line per new Item, and notify the person the
   way your brief says. If nothing arrived, end the turn without a word.

Do nothing else: no work on the asks, no sessions started, no triage beyond an obvious parent.
