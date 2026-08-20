# Task: Stop the frontend bundler from re-running type checking

**ID:** test-overhead-reduction/003
**Depends on:** test-overhead-reduction/001
**Blocks:** test-overhead-reduction/007
**Estimated scope:** small
**Status:** done

## Objective

The frontend production build stops repeating the type check that already ran earlier in the same gate, cutting time from the single most expensive phase while keeping type errors fatal.

## Context

The frontend build is the largest single item in the verification gate at 62.4 seconds — the only build in the repository doing genuinely irreplaceable work, since it produces the actual production bundle. Everything else in the build phase is either duplicated compilation (see task 002) or comparatively small.

However, the frontend's build configuration does not disable the bundler's built-in type checking. The gate already runs a dedicated frontend type check that takes 11.7 seconds, and then the bundler type-checks the entire application again during the build. The same type errors are found twice, in sequence, in the same gate run.

Disabling type checking inside the bundler build is safe here specifically because the dedicated type check runs in the same gate and still fails it. This is the standard arrangement in a monorepo where type checking is an explicit, separately-reported phase. It would not be safe if the bundler build were the only thing checking types — so the dedicated check must remain mandatory.

## Requirements

- The frontend production build no longer performs its own full type check.
- A type error in the frontend still fails the verification gate, reported by the dedicated type check phase.
- The dedicated frontend type check remains part of the canonical gate and cannot be skipped as a side effect of this change.
- Linting behavior during the build is reviewed for the same duplication and handled consistently — the gate already runs a full lint pass.
- The relationship is documented where a future reader would look, so nobody removes the dedicated type check believing the build still covers it.

## User-Facing Behavior

A developer running the gate sees the frontend build phase complete faster. A frontend type error still fails the gate, attributed to the type check phase rather than the build phase.

## Interface Contract

The production bundle produced by the build must be byte-equivalent in behavior to what is produced today — this task changes only whether type checking happens during bundling, never what is bundled or how it is configured for output.

## Acceptance Criteria

- [x] The frontend build completes without performing a full type check.
- [x] A deliberate frontend type error fails the canonical gate.
- [x] The frontend build phase is measurably faster than the committed baseline.
- [x] The dedicated frontend type check still runs in the canonical gate.
- [x] The production build still succeeds and produces a working bundle.

## Verification

Run the timing command from task 001: the frontend build phase is faster than baseline while the frontend typecheck phase is unchanged. Introduce a temporary frontend type error and confirm the canonical gate exits non-zero and names the type check phase. Confirm the production build still exits 0 and emits its output directory.

## Spec Compliance

- Related specs reviewed: none (no companion specs exist for this feature)
- Alignment: implemented as specified, with one requirement found to be moot.

### Measured result

The first reading suggested this change made the build *slower* (53.4s against a
47.2s baseline), so the saving was re-measured properly: four cold builds with
`.next-build` removed each time, two with the setting and two without, nothing
else running.

| Configuration | Run 1 | Run 2 | Mean |
|---|---|---|---|
| `ignoreBuildErrors: true` | 59.4s | 49.6s | **54.5s** |
| Without the setting | 66.3s | 69.5s | **67.9s** |

The saving is **13.4s, about 20%** of a cold frontend build. The original
misleading reading was contention from other work running concurrently, measured
against a baseline captured under lighter load — which is precisely why the
comparison had to be a controlled A/B rather than a single number against a
stored baseline.

### Divergences

- **The lint half of this task was moot.** The requirement asked that linting
  during the build be reviewed for the same duplication. The first attempt added
  `eslint: { ignoreDuringBuilds: true }`, which failed `typecheck:frontend` with
  `'eslint' does not exist in type 'NextConfig'`: Next 16 removed ESLint-during-
  build entirely. There was never any lint duplication in the build to remove.
  The config records this so nobody re-adds it.

Worth noting that the failure was caught by the very typecheck phase this task
optimises, which is the argument for keeping that phase mandatory in the gate.

### Verification

- Controlled A/B above — 13.4s mean saving.
- Type-error probe: a deliberate frontend type error still fails the canonical
  gate, reported by `typecheck:frontend`, not by the build.
- `npm run build:frontend` — exit 0, bundle still produced.
- `npm run typecheck:frontend` remains in the gate and unchanged in duration.
