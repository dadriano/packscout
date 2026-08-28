# Task: Consolidate the rejection matrix into table-driven coverage

**ID:** test-overhead-reduction/013
**Depends on:** test-overhead-reduction/012
**Blocks:** none
**Estimated scope:** large
**Status:** todo

## Objective

The fail-closed reason matrix is proven by parameterized tables rather than one hand-written block per reason per boundary, so the same behavior is covered in far fewer lines and adding a reason becomes a one-row change.

## Context

The services and database packages carry 14,657 lines of test code against 22,091 lines of production code. That ratio is not padding — it tracks a specification that is deliberately rejection-heavy. The product's policy is to never guess and always fail closed with a named reason, across roughly 21 distinct internal unavailable reasons. Each reason must be proven to reject, to emit exactly that reason, and to map to the correct public reason, and several boundaries can each produce it: the contract layer, the calculator, the provider normalizer, the store, and the publisher.

A matrix of that shape is intrinsically large. The question this task addresses is not whether to cover it, but how many lines it takes to express the coverage.

Where the same assertion shape repeats across many variants, a parameterized table proves the identical behavior with a fraction of the code, makes the matrix's completeness visible at a glance, and turns adding a twenty-second reason into adding a row rather than copying a block.

**This task begins with a survey, not with edits.** The per-file consolidation analysis has not been completed, so the builder must first establish where the repetition actually is before changing anything. Some cases will genuinely differ in shape and should stay as individual tests — the goal is consolidating true repetition, not forcing every test into a table.

Signals worth surveying: files with many deep-equality assertions relative to their length, blocks that vary only in an input value and an expected reason, the same internal-to-public reason mapping asserted at more than one boundary, and provider fixtures re-proving shared normalizer behavior once per provider across eight providers.

The absolute constraint: **which behaviors are proven must not change.** This task reduces how coverage is expressed. If a consolidation would drop a case, the consolidation is wrong.

## Requirements

- A survey identifies where repetition is genuine, recorded so the consolidation can be reviewed against it before and after.
- Every internal reason, every boundary that can produce it, and every internal-to-public mapping proven today is still proven after consolidation — demonstrably, not by assertion.
- Table cases are individually identifiable in test output, so a failure names the specific reason and boundary rather than reporting one opaque failing block.
- The tables make matrix completeness visible: a reader can see which reasons and boundaries are covered without reading every case.
- Cases that genuinely differ in setup or assertion shape remain individual tests rather than being forced into a table.
- Security-sensitive boundary coverage is untouched by this task. Authentication, sessions, authorization and tenant isolation, request validation, secrets and tokens, destructive actions, rate limiting, external writes, and audit behavior keep their direct tests, including the signed-transport suite covering the key matrix, digest tampering, nonce replay, and body caps.
- Exactness guarantees keep their coverage: byte-equivalent results, round-once half-up behavior, and the threshold, large-value, and repeat-run cases that prove them.
- Adding a new reason to the matrix requires adding a row, and omitting one is detectable.

## User-Facing Behavior

Not user-facing. A builder adding a rejection reason adds a table row and sees it covered at every boundary, instead of copying a test block five times.

## Interface Contract

The production modules under test keep their current exported names and behavior — this task changes tests only. The reason enumerations and mapping tables the tests consume must remain the single source of truth so the tests can be driven from them rather than restating them, which would reintroduce the mirror-test pattern task 010 removed.

## Acceptance Criteria

- [ ] A survey of repetition is recorded before consolidation begins.
- [ ] Every reason, boundary, and mapping covered before is still covered after, evidenced against the survey.
- [ ] Table cases are individually named in test output.
- [ ] Omitting a reason from the matrix is detectable rather than silently reducing coverage.
- [ ] Security-sensitive boundary tests are unchanged.
- [ ] Exactness and rounding coverage is unchanged.
- [ ] The services and database test lanes pass with no reduction in the set of behaviors proven.
- [ ] Test line count in the consolidated files is materially reduced.

## Verification

Run the services and database test lanes and confirm both exit 0. Confirm test output names each reason and boundary case individually. Then remove one reason from the driving enumeration and confirm the tables fail rather than silently covering less — proving completeness is enforced by the tables rather than assumed. Finally confirm the canonical gate still exits 0.
