---
description: Re-explain what you just said for a reader who is not a domain expert. Use when the user says they are not following, are still ramping up, asks you to back up, asks for simpler terms or more context, or triggers /rexplain. Rebuild the explanation from first principles rather than restating it.
---

# rexplain

The user did not follow the previous explanation. That is a fact about the
explanation, not about them. Do not restate it shorter. Rebuild it.

## What went wrong the first time

Almost always one of these:

- **Assumed vocabulary.** A term was used before it was defined, so every
  sentence after it landed on nothing.
- **Assumed a mental model.** The explanation described a *change* to a system
  the reader does not yet hold in their head.
- **Too many threads at once.** A bug, its consequences, a second unrelated bug
  and three open questions, interleaved.
- **Conclusion without the walk.** The answer arrived before the reasoning that
  makes it obvious.

Work out which one it was, then fix that specifically. If the first attempt
failed on vocabulary, adding more prose will fail too.

## Rules

**Use the domain's own words, and define each one on first use.** If the
codebase has a model called `LoanRefundLeg`, call it a `LoanRefundLeg`, not "a
piece of the refund". Inventing a friendlier synonym costs the reader the ability
to search for it, recognise it in a PR, or say it in a meeting. Define it once,
in one clause, then use it consistently. Never introduce a second word for
something that already has a domain model.

**Simplify the structure, never the facts.** Keep exact names, exact numbers,
exact statuses. What gets simpler is the order things arrive in and how much
arrives at once. A vaguer explanation is not a simpler one.

**Run one concrete example the whole way through.** Pick real numbers and reuse
them in every section. A reader who can follow one $1000 loan through the whole
flow has a model; a reader given four abstractions has none.

**Build up, do not drill down.** Start from what the feature is for, in one
sentence a non-engineer would accept. Then the pieces involved. Then how they
fit. Only then what is wrong.

**Separate the categories explicitly.** Label what is settled, what is broken,
what is a judgment call you made, and what nobody has decided. Blurring these is
what makes a status feel like a wall of problems. Give each its own heading.

**Name the stakes before the mechanism.** Say what breaks and who is affected,
then how. "The Loan is never marked refunded, so nothing downstream believes it
was" before the branch condition that causes it.

**Say plainly what is not known.** Distinguish "I verified this in code" from "I
believe this" from "nobody has decided this". A reader ramping up cannot tell
these apart from tone, and will assume everything is equally certain.

**Correct yourself out loud.** If the earlier explanation was wrong or
overstated, say which part and why, rather than quietly explaining it
differently.

## Shape

Roughly this, trimmed to what the question needs:

1. **What this is for.** One sentence, no jargon.
2. **The pieces.** Each domain model named and defined in a clause.
3. **How it normally works.** The concrete example, running.
4. **What is wrong.** The same example, at the point it breaks. Stakes first.
5. **What is separate.** Other findings, clearly fenced off as not the same
   thing.
6. **What is open.** Decisions, and who owns each.
7. **What happens next**, and what you need from the user, if anything.

Skip any section that does not apply. Do not pad to fill the shape.

## Do not

- Re-explain by adding adjectives. Restructure instead.
- Bury a correction in a re-explanation.
- Substitute an analogy for the domain term. An analogy alongside it is fine.
- List everything you know. Answer what was asked, in the order that makes it
  land.
- Ask "does that make sense?" as a closer. Offer a specific next section to go
  deeper on, since that is answerable.

## After

Offer the one section most likely to still be unclear, and ask whether to expand
that. Naming a candidate is more useful than a general offer, because it gives
the reader something concrete to accept or redirect.
