# Task: Restore incremental TypeScript compilation

**ID:** test-overhead-reduction/004
**Depends on:** test-overhead-reduction/001
**Blocks:** test-overhead-reduction/007, test-overhead-reduction/008
**Estimated scope:** small
**Status:** done

## Objective

Repeated type checks reuse the compiler's cache instead of starting cold every time, so the inner development loop and cached CI runs get materially faster.

## Context

Two type check commands in this repository explicitly pass a flag that disables TypeScript's incremental compilation. These are the two most expensive type checks in the gate — the frontend at 11.7 seconds and the Convex backend at 3.9 seconds — so the cache is being discarded exactly where it would help most.

Incremental compilation is almost certainly disabled here to guarantee a clean result, which is a reasonable instinct for a release gate but costly for the development loop, where an agent may run type checks many times while iterating on a single task. TypeScript's incremental mode is designed to be correct: it invalidates on input change and on compiler-option change. The risk it is being protected against is a stale build-info file, which is handled by making the cache location predictable and clearable rather than by never using a cache.

The cache files must be excluded from version control and from the repository's own policy checks, and must participate in CI caching to have any effect there (see task 008).

## Requirements

- Repeated type checks reuse compiler state rather than recompiling from scratch.
- A cold, cache-free type check remains possible and is what CI uses when its cache is absent or invalidated.
- Compiler build-info artifacts are ignored by version control, by the linter, and by the repository's policy checkers, so they cannot become a new source of false gate failures.
- Correctness is preserved: an error introduced after a successful cached run is still caught on the next run.
- A documented way exists to force a cold check when a result is in doubt.
- Cache artifacts live in predictable locations so CI can cache and restore them.

## User-Facing Behavior

A developer or agent running type checks repeatedly during a task sees the second and subsequent runs complete noticeably faster than the first, with identical results.

## Interface Contract

Emits compiler build-info artifacts at stable, documented paths. Task 008 restores and saves these paths in CI, so the locations must not be incidental or scattered.

## Acceptance Criteria

- [x] Type checks reuse compiler state across consecutive runs.
- [x] A second consecutive type check is measurably faster than the first.
- [x] Introducing a type error after a successful cached run still fails the check.
- [x] Build-info artifacts are ignored by version control, lint, and the repository policy checkers.
- [x] A cold type check can still be forced and produces the same result as a cached one.

## Verification

Run the affected type checks twice in a row and confirm the second run is measurably faster while both exit 0. Then introduce a type error, run again, and confirm it exits non-zero — proving the cache does not mask new errors. Finally run the repository's policy checkers and the linter and confirm the build-info artifacts produce no findings.

## Spec Compliance

- Related specs reviewed: none (no companion specs exist for this feature)
- Alignment: implemented as specified.

### What changed

`--incremental false` was removed from `typecheck:frontend` and
`typecheck:convex`. The frontend's `tsconfig.json` already declared
`"incremental": true`, so the CLI flag had been actively overriding a setting the
project had deliberately opted into. The Convex tsconfig had no such setting and
gained one.

Build-info artifacts were already covered by `.gitignore` (`*.tsbuildinfo`), and
they carry an extension none of the policy checkers or the linter inspect, so no
new ignore rules were needed. Task 005's shared ignore module covers the
generated output directories they sometimes sit beside.

A cold check remains available by deleting the `.tsbuildinfo` file for a project,
which is what the measurements below did between runs.

### Verification

Consecutive runs, cache cleared before the first:

| Phase | Cold | Warm |
|---|---|---|
| `typecheck:frontend` | 8925ms | 4922ms |
| `typecheck:convex` | 2999ms | 1187ms |

- Correctness after caching: with a warm cache from a passing run, a deliberate
  type error in the frontend and in Convex still fails the check. The cache does
  not mask new errors.
- `npm run check:framework` — exit 0 with build-info artifacts present.
- `git status` — no `.tsbuildinfo` files appear as untracked.
