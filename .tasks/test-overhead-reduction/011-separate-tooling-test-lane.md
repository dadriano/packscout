# Task: Separate tooling self-tests from the product test gate

**ID:** test-overhead-reduction/011
**Depends on:** test-overhead-reduction/005
**Blocks:** test-overhead-reduction/012
**Estimated scope:** small
**Status:** done

## Objective

Tests that exercise developer scripts and the repository's own policy checkers stop running on every product change, removing the single largest slice of test runtime from the common path while still protecting that tooling when it changes.

## Context

The slowest test lane in the repository does not test the product. It takes 44 seconds — 40% of all test runtime, more than the services and database lanes combined — across 3,132 lines, and spawns child processes 13 times.

What it covers:

- **1,840 lines of local developer tooling.** Tests for restart scripts, branch-update scripts, mock data simulators, and local server launchers. The two largest files alone are 590 and 555 lines.
- **1,292 lines of policy-checker self-tests.** Tests for the boundary checker, dependency checker, docs checker, script checker, standards scanner, and the test runner itself.

None of it proves anything about repacks, expected value, providers, or any other product behavior. It is stable infrastructure that changes rarely, yet it is re-verified on every product commit.

This is not an argument for deleting these tests. The checkers enforce real repository standards and the local scripts are used daily; both deserve coverage. The argument is that their coverage does not need to run on a commit that touches only a React component.

This depends on task 005 because the test runner's lane definitions and the shared ignore rules are adjacent concerns, and the ignore-pattern work should settle before lane membership changes.

## Requirements

- Tooling self-tests are addressable as their own verification lane, separate from the product test lanes.
- The common product verification path does not run the tooling lane.
- The tooling lane still runs when the code it covers changes, and when the canonical full gate runs before handoff.
- No test is deleted — this task changes when tests run, not whether they exist.
- The test runner's existing safety behaviors are preserved: discovering zero tests in a lane must still be an error, and the quarantine rules must continue to apply across all lanes.
- The arrangement is documented so a future reader understands the tooling lane is deferred by design, not forgotten.

## User-Facing Behavior

A developer changing a product file runs the tests and they complete roughly 44 seconds faster. A developer changing a policy checker or a local script sees the tooling lane run and fail if they broke it.

## Interface Contract

The canonical full gate must still execute every lane including the tooling lane, so its overall coverage is unchanged. Task 009's affected-only lane must be able to select the tooling lane when tooling files change; task 012 documents the resulting policy.

## Acceptance Criteria

- [x] Tooling self-tests run as their own named lane.
- [x] The product test path no longer includes the tooling lane and is measurably faster.
- [x] Changing a policy checker or local script causes the tooling lane to run.
- [x] The canonical full gate still runs every lane, tooling included.
- [x] No test files are deleted or quarantined by this task.
- [x] Zero-discovery and quarantine safety behaviors still apply to every lane.

## Verification

Run the product test path and confirm it exits 0 without executing the tooling lane, measurably faster than the committed baseline. Run the tooling lane directly and confirm it exits 0 and executes the same test count as before. Confirm the canonical full gate still runs both. Then break a policy checker and confirm the tooling lane fails.

## Spec Compliance

- Related specs reviewed: none (no companion specs exist for this feature)
- Alignment: implemented as specified.

### What changed

The `root` target in `scripts/run-tests.mjs` is now named `tooling`, which is
what it always was — every one of its files lives under `scripts/`, and the
`__tests__` root it also scanned does not exist. `npm test` runs the product
lanes; `npm run test:tooling` runs the tooling lane; `npm run verify:framework`
runs both, so nothing reaches handoff unverified.

No test was deleted, quarantined, or skipped. The lane still discovers 20 files
and runs 134 tests. The runner's existing safety behaviours are untouched: a lane
discovering zero tests is still an error, and the quarantine rules still apply
across every lane — including the self-test that proves a fully quarantined lane
fails, which still passes.

`docs/testing/shift-left-bdd.md` was updated so the commands table is accurate
and the split is documented as deliberate. Task 012 revises that document more
deeply; this was the minimum needed to stop the docs describing a command that no
longer exists.

### Measured result

| Path | Duration |
|---|---|
| `npm test` (product lanes) | 21.4s |
| `npm run test:tooling` | 40.6s |
| Baseline test group (both, combined) | 94.3s |

A product change now pays 21.4s of tests instead of the full group. Part of that
drop is task 006 rather than this task; the portion attributable here is the
40.6s tooling lane leaving the product path.

### Divergences

- **"Changing a policy checker or local script causes the tooling lane to run" is
  satisfied by the full gate, not by change detection.** Nothing yet inspects the
  working tree to decide which lanes to run — that is task 009's affected-only
  lane, which is not built. Today the guarantee is that `verify:framework` always
  runs the tooling lane, so a broken checker cannot reach handoff. The
  documentation tells contributors to run the lane directly when touching
  `scripts/`. When task 009 lands it should select this lane on `scripts/` changes
  and close the gap properly.

### Verification

- `npm run test:tooling` — 20 files discovered, 134 tests, 0 failures.
- `npm test` — exit 0, tooling lane not executed.
- `npm run verify:framework` includes `test:tooling` (see integration pass).
- Zero-discovery and quarantine self-tests still pass within the lane.
