---
name: code-review
description: Review code before, during, or after implementation, and when asked to review a PR or audit a codebase. Start with ownership, scope, and the chosen approach; then examine how the change fits the system and apply the existing clean-code smells. Use early when choosing a design, revisit when the work changes direction, and review the diff before delivery.
---

# Code review

Review from the largest decisions down to the code. Ask what could have been
written, including code outside the diff and approaches that avoid new code
altogether.

Use this skill:

- **Before implementation:** check ownership, scope, and approach.
- **During implementation:** revisit those questions when the work expands,
  changes direction, or begins accumulating unexpected complexity.
- **After implementation:** review the diff through the layers below.
- **When asked to review a PR or audit a codebase:** apply the layers to the
  requested scope, whether or not you wrote the code.

Read this skill when it first becomes relevant. Revisit the appropriate layer
as the work progresses; do not reread the whole skill for every edit.

For the detailed clean-code guide, read
[references/clean-code-smells.md](references/clean-code-smells.md).

## Review layers

Work through these in order. Spend more time where the change warrants it.
A small fix may need only a quick check of the early layers.

### 1. Scope and ownership

Should this work happen here, and at this boundary?

- Who owns the capability: this product, a shared platform, or another team?
- Is there an existing system, project, proposal, or established way to
  request the capability?
- Is the change in the right place, and who will maintain it?
- Is there a reason to coordinate before building a product-local or shared
  solution?

Use the ownership and project context available to you. Do not invent a team
boundary or assume another effort exists. If the answer is unknown and it
matters, state the uncertainty.

Ownership is not an automatic veto. A local solution, a contribution to shared
code, or coordination with another team may each be appropriate depending on
the context.

### 2. Problem and approach

Does the change solve the right problem in a sensible way?

- What behavior is needed, and what constraints does it have to satisfy?
- Is there an existing capability, API, data source, or simpler approach?
- What does the proposed complexity buy?
- Would an alternative preserve the requirements and important tradeoffs?

Look beyond the diff. Do not prefer an alternative solely because it is
shorter. A more involved approach may be justified by the requirements.

### 3. System design and boundaries

Does the approach fit the surrounding system?

Read enough neighboring code and project documentation to understand where
the change belongs. Look at responsibilities, dependencies, shared state,
and contracts across boundaries.

Use the relevant clean-code checks, especially:

- Implicit coupling
- Layer-first folders
- Duplication
- Shotgun surgery
- Layering violations

### 4. Implementation

Is the chosen design expressed clearly and safely?

Follow the changed paths and apply the remaining relevant clean-code checks:

- Representable illegal states
- God files
- Pass-through wrappers
- Errors and validation not at the boundary
- Implicit state machines
- Unnecessary sequential async calls
- Whole-row loads
- Behaviour away from its data

A bug found while reviewing is a bug, not a smell. Report it separately.

### 5. Verification

What demonstrates that the change works?

Read the tests and check whether they cover the behavior the change is for.
Watch for change-detector tests that pin implementation rather than behavior.

Record what you verified and what remains unverified. Passing tests are
evidence, but do not by themselves establish that the approach is right.

## Reviewing a diff

Review what the diff introduces or makes worse, using surrounding context
where needed to judge it. A pre-existing smell the diff touches gets at most
one line and is not, by itself, a reason to grow the change.

Review from the top down: a finding about ownership or approach comes before
comments about the internals of a design that may need to change.

## Auditing a codebase

Read the repo's own docs first and judge it against both the review layers
and its stated design. Skip generated and vendored code, build output,
lockfiles, and fixtures.

For the fourteen smells, retain the existing ratings: clean, minor, notable,
or severe. Clean is a valid rating. Give every claim a path and line, or a
path and measurement.

## Findings

- Report bugs first and separately from smells.
- Verify each finding against the code and its context.
- Give each code finding a path and line, its consequence, and a concrete
  direction for fixing it.
- Distinguish confirmed findings from open questions or unverified risks.
- List findings in order of consequence. Do not pad a clean review.
- End with verification performed and anything important still unverified.
