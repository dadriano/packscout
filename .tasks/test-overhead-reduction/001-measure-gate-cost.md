# Task: Capture a repeatable gate timing baseline

**ID:** test-overhead-reduction/001
**Depends on:** none
**Blocks:** test-overhead-reduction/002, test-overhead-reduction/003, test-overhead-reduction/004, test-overhead-reduction/006, test-overhead-reduction/007, test-overhead-reduction/008
**Estimated scope:** small
**Status:** done

## Objective

Anyone can run one command and see how long each phase of the verification gate takes, so the savings claimed by every later task in this feature can be proven rather than assumed.

## Context

An audit of this repository found that the full verification gate takes roughly 246 seconds locally and 8–10 minutes in CI, but that the distribution is counterintuitive: running all 151 test files takes only 110 seconds, while duplicated compilation and tooling self-tests account for a large share of the rest.

Every subsequent task in this feature claims a specific time saving. Without a repeatable measurement those claims cannot be verified, and a future change could silently reintroduce the waste. This task builds the instrument first.

Measured starting point on the branch where the audit ran (cold caches, Node 22, local PostgreSQL available):

| Phase | Time |
|---|---|
| lint | 21s |
| typecheck | 28s |
| build | 69s |
| test (all lanes) | 110s |
| framework checks + prisma checks | 18s |
| **total** | **246s** |

Test lanes individually: root 44s, services 24s, database 21s, admin 7s, worker 6s, convex 3s, frontend 3s, contracts 2s.

## Requirements

- A single command runs each phase of the canonical verification gate in sequence and reports the wall-clock duration and exit status of each phase separately.
- Per-workspace granularity is available for the compilation phases, because later tasks change individual workspaces and need to show which one improved.
- Output is readable in a terminal and also emitted in a machine-parseable form so it can be diffed between runs or captured in CI.
- The measurement itself must not meaningfully distort the result — no added installs or code generation inside the timed window.
- Phases that fail are still timed and reported rather than aborting the whole measurement, since the repository currently has failing gates that later tasks resolve.
- A baseline capture from before any optimization is committed to the repository so later runs have something to compare against.

## User-Facing Behavior

A developer or agent runs the timing command and sees a per-phase table showing where gate time is spent, with failing phases clearly marked rather than silently truncating the run.

## Interface Contract

Produces a committed baseline record containing, at minimum, a phase name, duration in milliseconds, and exit status per phase. Tasks 002, 003, 004, 006, 007, and 008 read this record to demonstrate improvement, so the phase names must be stable and must cover: lint, typecheck, build, each test lane, and the framework/prisma check groups.

## Acceptance Criteria

- [x] One command produces per-phase timings for the whole verification gate.
- [x] Compilation phases report per-workspace timings, not just an aggregate.
- [x] A phase that exits non-zero is reported with its failure status and does not prevent the remaining phases from being timed.
- [x] A baseline record captured before any optimization work is committed to the repository.
- [x] Re-running the command produces comparable output that can be diffed against the committed baseline.

## Verification

Run the new timing command on a clean checkout. It exits 0, emits a timing entry for every phase of the canonical gate including each test lane, and at least one entry reflects a currently-failing gate without aborting the run. Confirm the committed baseline file parses and contains the same phase names the command emits.

## Spec Compliance

- Related specs reviewed: none (no companion specs exist for this feature)
- Alignment: implemented as specified.

### Implementation notes

The pure logic (phase catalog, formatting, summarisation, baseline comparison)
lives in `scripts/gate-phases.mjs` with unit tests, and the CLI in
`scripts/measure-gate.mjs` runs the phases. This follows the repository's
existing pattern of a testable module beside its executable, as with
`glob-escape.mjs` and `port-range.mjs`, and keeps the tests fast — testing the
CLI directly would mean running the gate.

`compareToBaseline` reports phases present in only one record as `added` or
`removed` rather than dropping them. This matters immediately: task 002 removes
four build phases, and without this a 12.7s saving and a silently deleted phase
would look identical.

### Baseline captured

`docs/gate-timing-baseline.json` — 206.5s across 33 phases, all passing.

| Group | Total |
|---|---|
| check | 5.0s |
| lint | 13.3s |
| typecheck | 28.1s |
| test | 94.3s |
| build | 65.8s |

Notable within those: `test:root` 56.5s (60% of all test time, and it exercises
no product code), `build:frontend` 47.2s, `test:database` 18.0s, and 12.7s across
the four builds that duplicate typecheck exactly.

### Sequencing note

The baseline was captured after tasks 005 and 010 landed, since all three are
dependency-free Group A work. Neither materially affects gate timing — 005
removes some directory walking and 010 only changes test content — and neither
touches any phase that tasks 002 through 008 will change. Every task this one
gates is still unstarted, so the baseline is a valid reference for all of them.

It also records a gate where every phase passes, which is itself the evidence
that task 005 cleared the three failing gates.

### Verification

- `node --test scripts/gate-phases.test.mjs` — 9 tests, 9 pass
- `npm run measure:gate:baseline` — exit 0, wrote the record, all 33 phases timed
- `npm run check:scripts` — exit 0 with the two new npm script names

## Correction: the baseline was not comparable to a gate run

A later question exposed a methodology error in how this baseline was used.

`docs/gate-timing-baseline.json` records **206.5s**, and that figure was reported
against `verify:framework` timings as though the two were the same measurement.
They are not:

- The baseline is the **sum of 33 separately invoked `npm run <phase>` commands**.
  `verify:framework` is one chained command. Each separate invocation pays npm's
  own startup cost, so the sum is inflated relative to a chained run.
- **The catalog omits `check:prisma` entirely.** The gate runs eight top-level
  steps; the catalog covers `check:prisma-only` but not `check:prisma`, which is
  `prisma validate` + `generate` + three Prisma test lanes and measures **13.6s**.
  The baseline was missing real work the gate does.

So the claim "206.5s to 164.6s" was not like-for-like and should not be repeated.

### The measurement that was missing

The correct comparison is `origin/main` (all of main's current code, none of the
changes in this feature) against this branch (the same code plus the changes),
both running the actual gate:

| Gate run | Duration |
|---|---|
| `origin/main`, cold caches | **348.4s** |
| this branch, cold caches | **269.3s** |
| this branch, warm caches | 214.3s |

**79s faster cold, a 23% reduction.** Cold-versus-cold is the conservative
figure and the one to quote: it understates the benefit of task 004's
incremental compilation, which by definition only pays on a warm cache, but it
is the state a fresh CI runner most resembles.

### What still holds

The per-phase numbers reported throughout this feature were measured the same
way before and after, on the same branch, and remain valid: lint 13.3s to 8.4s,
typecheck 28.1s to 13.1s, `test:database` 18.0s to ~5.7s, the four removed
duplicate builds at 12.7s, and the frontend build A/B at 13.4s.

What was wrong was only the gate-level headline, where a sum of parts was
compared against a whole.

### What this says about the instrument

The catalog should include `check:prisma`, and `measure:gate` should be able to
time `verify:framework` end to end as its own phase so that a gate-level
before-and-after is available without hand-assembling one. Both are worth doing
before the next round of optimisation work leans on these numbers.
