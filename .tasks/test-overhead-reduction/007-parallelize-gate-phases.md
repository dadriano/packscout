# Task: Run independent gate phases concurrently

**ID:** test-overhead-reduction/007
**Depends on:** test-overhead-reduction/002, test-overhead-reduction/003, test-overhead-reduction/004
**Blocks:** test-overhead-reduction/009
**Estimated scope:** medium
**Status:** todo

## Objective

The verification gate runs work that has no ordering requirement at the same time instead of strictly one after another, so total wall-clock time approaches the slowest single phase rather than the sum of all of them.

## Context

Every aggregate command in this repository chains its steps with a shell operator that runs them strictly in series. Linting seven workspaces, type-checking seven workspaces, and running eight test lanes all happen sequentially, even though these are mutually independent operations that neither share state nor depend on each other's output.

The consequence is that the gate's duration is the sum of every phase. After the duplication removed by tasks 002, 003, and 004, the remaining work is dominated by a single long pole — the frontend production build at roughly 62 seconds — with everything else being much shorter. Running the independent work concurrently means the gate approaches the length of that long pole instead of stacking everything behind it.

A concurrency tool is already a dependency of this repository, so this does not require introducing new tooling.

Some ordering is real and must be preserved. Code generation for the database client must complete before anything that consumes the generated client compiles or runs. The applications depend on the shared packages. These real dependencies must be respected while the artificial serialization is removed.

This task depends on 002, 003, and 004 because parallelizing duplicated work would hide the duplication rather than remove it — the waste should be gone before concurrency masks its cost.

## Requirements

- Independent phases execute concurrently; genuinely dependent phases still run in the correct order.
- A failure in any phase still fails the gate, and the output makes clear which phase failed.
- Interleaved output from concurrent phases remains attributable — a developer can tell which workspace produced which message.
- Concurrency is bounded so the gate does not exhaust memory or CPU on a developer machine or a CI runner.
- Test lanes that require exclusive external resources are not run concurrently in a way that makes them flaky; database-backed lanes must remain reliable, and any lane that cannot safely parallelize is documented as such.
- The gate remains deterministic: repeated runs on an unchanged tree produce the same pass/fail result.
- The canonical gate command keeps its current name and contract.

## User-Facing Behavior

A developer running the full gate sees phases progress concurrently with clearly labeled output, and the run completes substantially faster than the serial equivalent.

## Interface Contract

The canonical verification command and the individual phase commands keep their existing names so CI, the timing instrument from task 001, and developer habit all continue to work. Task 009 builds a narrower lane on top of this arrangement and needs per-workspace phase commands to remain independently invocable.

## Acceptance Criteria

- [ ] Independent lint, type check, and test phases run concurrently.
- [ ] Real dependencies — client generation before dependent compilation, packages before applications — are still respected.
- [ ] A failure in any single phase fails the whole gate and is clearly attributed.
- [ ] Output from concurrent phases is labeled by workspace.
- [ ] Repeated runs on an unchanged tree produce identical results, with no flakiness introduced in database-backed lanes.
- [ ] Total gate wall-clock time is substantially below the serial baseline.

## Verification

Run the canonical gate and confirm it exits 0 with total wall-clock time well below the committed serial baseline from task 001. Run it three times consecutively on an unchanged tree and confirm identical results each time. Then introduce a deliberate failure in one workspace and confirm the gate exits non-zero and names that workspace.
