# Task: Codify what the audit learned in the testing standard

**ID:** test-overhead-reduction/012
**Depends on:** test-overhead-reduction/010, test-overhead-reduction/011
**Blocks:** test-overhead-reduction/013
**Estimated scope:** medium
**Status:** todo

## Objective

The canonical testing standard names the specific patterns that produced the current overhead, so future features avoid them by default instead of rediscovering them in another audit.

## Context

The repository's shift-left testing standard already states that the goal is readable regression coverage rather than test volume for its own sake, and already requires direct boundary coverage for security-sensitive paths. Both are correct and neither is in question here.

What the standard does not currently do is name the patterns that actually generated the excess:

**Mirror tests.** Nothing forbids asserting equality against a literal transcription of a source constant. Two files did exactly that and became the sole cause of 7 failing tests when copy changed. Task 010 rewrites them; this task turns that into a rule.

**Compound acceptance criteria.** The standard makes each acceptance criterion an automation obligation, which is right, but says nothing about criterion granularity. A single checkbox reading "positive, neutral, negative, zero-payout, uniform-rate, outcome-specific, fixed-offer, fee, cap, floor, per-pack, and per-draw cases produce exact results" is twelve distinct test cases hidden behind one tick. The cost is invisible at planning time and lands entirely on the builder.

**Per-case enumeration of matrices.** Where a specification enumerates many variants of the same rejection across several boundaries, writing one test block per variant per boundary multiplies quickly. A parameterized table proves the same behavior in a fraction of the lines and makes adding a variant a one-row change.

**Lane placement.** Task 011 establishes that tooling self-tests run separately from product tests. That policy needs recording, or it will be undone by someone who reads the current standard's discovery rules and assumes everything belongs in one place.

This task depends on 010 and 011 so the standard documents patterns that already exist in the codebase as working examples, rather than describing an aspiration.

## Requirements

- The standard states that an expected value which is a literal transcription of a source constant is not acceptable coverage, explains why (it detects edits, not defects), and points to the rewritten tests as the reference example.
- The standard states the invariant-assertion alternative concretely enough to be actionable.
- The standard requires acceptance criteria to be enumerated rather than compound, or explicitly permits one criterion to map to a parameterized table — whichever the team prefers — so that criterion cost is visible at planning time.
- The standard expresses a preference for table-driven coverage where a specification enumerates many variants of one behavior, while keeping per-case tests where the cases genuinely differ in shape.
- The standard records that tooling self-tests occupy their own lane and are not part of the product test path.
- The existing security clause is preserved verbatim in effect: direct boundary coverage remains required for authentication, sessions and cookies, authorization and tenant isolation, request validation, secrets and tokens, destructive actions, rate limiting, external writes, and audit behavior. Nothing in this task may be read as licence to reduce that coverage.
- The distinction between reducing how coverage is *expressed* and reducing what is *covered* is stated explicitly, because that distinction is what makes the rest of this feature safe.
- Any other repository document that would now contradict the standard is updated for consistency.

## User-Facing Behavior

A builder reading the standard before writing tests for a new feature learns which patterns to avoid and what to write instead, with a concrete in-repository example of each.

## Interface Contract

Remains the canonical testing standard referenced by the project guide and the definition of done. Task 013 implements the table-driven preference this task establishes, so the guidance must be specific enough to build against.

## Acceptance Criteria

- [ ] The standard names the mirror-test anti-pattern, explains why it fails, and cites the reference example.
- [ ] The standard describes the invariant-assertion alternative actionably.
- [ ] The standard addresses acceptance-criterion granularity so compound criteria no longer hide their cost.
- [ ] The standard expresses the table-driven preference for enumerated variant matrices.
- [ ] The standard records the tooling lane policy.
- [ ] The security clause's requirements are unchanged in effect.
- [ ] The expression-versus-coverage distinction is stated explicitly.
- [ ] The repository's documentation checks pass and no other document contradicts the standard.

## Verification

Run the repository's documentation and framework check group and confirm it exits 0 with the revised standard in place. Confirm by reading that the security clause's enumerated paths are unchanged, and that each new rule cites an existing in-repository example a builder can open.
