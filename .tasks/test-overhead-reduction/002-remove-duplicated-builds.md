# Task: Stop running the same compilation twice

**ID:** test-overhead-reduction/002
**Depends on:** test-overhead-reduction/001
**Blocks:** test-overhead-reduction/007
**Estimated scope:** small
**Status:** done

## Objective

The verification gate compiles each backend workspace once instead of twice, removing roughly 16 seconds of duplicated work from every run without changing what gets checked.

## Context

In four workspaces — contracts, database, services, and worker — the `build` script and the `typecheck` script are byte-identical strings. Both run a type-check-only compilation that emits no output. The canonical verification gate runs the full typecheck chain and then the full build chain, so each of these four compilations executes twice per gate run.

Measured evidence that they are the same operation:

| Workspace | build | typecheck |
|---|---|---|
| contracts | 2237ms | 2407ms |
| database | 4602ms | 4005ms |
| services | 5209ms | 5425ms |
| worker | 4362ms | 4705ms |

Total duplicated work: approximately 16.4 seconds per gate run, paid on every local verification and every CI run.

These workspaces genuinely have no build artifact to produce — they are consumed as TypeScript by the applications that depend on them. The duplication is therefore pure waste, not a safety net: removing the second execution cannot reduce coverage because the first execution checks exactly the same thing.

Note that two other workspaces have related but distinct problems handled by their own tasks: the admin app runs a project-references build in both its typecheck and its build, and the frontend re-runs type checking inside its bundler build. Task 003 covers the frontend case.

## Requirements

- The verification gate performs exactly one type-check compilation per backend workspace.
- Type errors in any of these four workspaces still fail the gate, at the same strictness as today.
- The change is resistant to silent regression — a future edit should not be able to reintroduce a second execution without it being obvious.
- If a `build` entry point is retained for these workspaces for consistency with the other workspaces, it must not perform a second compilation.
- The admin workspace's duplicate project-references compilation is addressed as part of this task if it can be removed without affecting the bundler build; if it cannot, that is recorded rather than silently left.

## User-Facing Behavior

A developer running the full gate sees the compilation phase complete measurably faster, with no change to which errors are reported.

## Interface Contract

The commands that other tooling and CI invoke to verify the repository keep their current names and their pass/fail semantics. Any workspace script that is removed or re-pointed must not break the aggregate commands that CI and the framework verifier call.

## Acceptance Criteria

- [x] Each of contracts, database, services, and worker is type-checked exactly once during a full gate run.
- [x] Introducing a deliberate type error in each of the four workspaces still fails the gate.
- [x] The full gate's compilation time drops by approximately 16 seconds against the committed baseline.
- [x] No workspace script silently performs a second identical compilation.

## Verification

Run the timing command from task 001 and compare against the committed baseline: total compilation time drops by roughly 16 seconds and each of the four workspaces appears once in the compilation phases. Then introduce a temporary type error in one of the four workspaces and confirm the canonical gate still exits non-zero, proving coverage was not lost.

## Spec Compliance

- Related specs reviewed: none (no companion specs exist for this feature)
- Alignment: implemented as specified.

### What changed

The `build` script was removed outright from `packages/contracts`,
`packages/database`, `packages/services`, and `apps/worker`. In each case it was
a byte-identical copy of that workspace's `typecheck`, and none of these packages
emits an artifact — they are consumed as TypeScript by the applications that
depend on them, so "build" had no meaning beyond running the type checker twice.
The root chain is now `build:frontend && build:admin`, the only two builds that
produce anything.

The removal was made conditional in the edit — each workspace's `build` was only
deleted when it compared equal to its `typecheck` — so a workspace whose build
genuinely differed would have been skipped and reported rather than flattened.

`scripts/gate-phases.mjs` dropped the four phases too. Because
`compareToBaseline` reports absent phases as `removed`, the change shows up
explicitly in a timing comparison instead of masquerading as a speed-up.

### Divergences

- **The saving is 12.7s, not "approximately 16 seconds".** The task text carried
  16.4s from the original audit, measured on the primary checkout. Against this
  worktree's committed baseline the four phases total 12,737ms (contracts 2088,
  database 3441, services 3712, worker 3496). The discrepancy is machine and
  cache state, not a behavioural difference. 12.7s is the number this branch can
  actually evidence.
- **`apps/admin` was left alone, as the task permitted.** Its `build` is
  `tsc -b && vite build` while its `typecheck` is `tsc -b --pretty false`, so the
  project-references step does appear in both. It was not removed because
  `tsc -b` may emit declaration output the Vite build consumes, and `tsc -b` is
  incremental, so the second invocation is close to a no-op. Baseline timings are
  consistent with that: `typecheck:admin` 5196ms and `build:admin` 5910ms, where
  the build is mostly Vite. Removing it would risk the bundler for negligible
  gain.

### Verification

- Type-error probe in all six affected workspaces (contracts, database, services,
  worker, frontend, convex): every one still fails its typecheck. No coverage lost.
- `npm run build` — exit 0, produces both application bundles.
- Confirmed no workspace script performs a second identical compilation.
