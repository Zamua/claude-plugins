---
description: Write a very short brief on where the work stands and what needs the user. Use when the user says they have lost the thread, is returning after a break, asks to be reoriented, asks what needs them, or triggers /briefme. One paragraph, then only the open decisions.
---

# briefme

The user cannot follow the session anymore. Give them the smallest thing that
lets them make the next decision. Not a summary of what happened.

## Shape

**One paragraph.** Where the work stands right now, in plain sentences. Lead
with the single most important fact. Name exact things: PR numbers, branches,
test counts, statuses.

**Then, only if they exist, the open items.** A short list, each one line, each
phrased as the decision to make rather than the background to it. Say who it is
blocked on: the user, a machine, or another person.

If nothing needs them, say that in one line and stop. "Nothing needs you, X is
running" is a complete brief.

## Rules

**Current state, not history.** They are not asking what you did. Skip the
investigation, the wrong turns, the things already fixed. A fact earns its place
only if it changes what happens next.

**No tool narration.** Never mention greps, files read, commands run, or how
long something took.

**Separate settled from open.** Anything already decided is settled, even if it
was decided five minutes ago. Do not reopen it, re-justify it, or ask again.

**A decision is theirs only if you genuinely cannot make it.** Merging, sending,
publishing, scope changes, and anything irreversible are theirs. Choosing a
variable name is not. Do not manufacture questions to look thorough.

**Name what is uncertain.** If something is unverified or you are guessing, say
so in the same breath. Do not present a hunch as a finding.

**No reassurance.** No "great progress", no "as you know", no recap of their own
instructions back to them.

## Length

Aim for under 150 words total. If the state genuinely cannot be said that
briefly, say the one thing that matters and offer to expand on the rest.
Length is the failure mode this skill exists to prevent.
