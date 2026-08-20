# Feature: Test Overhead Reduction

## Context

An audit of this repository measured the full verification gate end to end and found that the intuitive diagnosis — a large test suite being slow to run — was wrong, while the underlying concern was right.

**What the measurements showed.** Running all 151 test files across all eight lanes takes 110 seconds. Even at three runs per task, that is under six minutes. The full gate takes roughly 246 seconds locally and 8–10 minutes in CI, where it runs twice per merge; the last fifteen CI runs total about 134 minutes, roughly half of it re-verifying commits that already passed on their pull request.

**Where the waste actually is.** Four workspaces have `build` and `typecheck` scripts that are byte-identical strings, so the gate compiles them twice for 16.4 seconds of pure duplication. The frontend bundler re-runs a type check the gate already performed. Incremental compilation is explicitly disabled on the two most expensive type checks. The slowest test lane, at 44 seconds and 40% of all test runtime, tests developer scripts and the repository's own policy checkers rather than any product behavior. Thirty database-backed tests each spawn a full migration deployment when a schema clone would do.

**Where the friction is.** The gate cannot currently pass on a clean checkout, and none of the three failures is a product defect. Two come from ignore-pattern drift — every gate tool skips one worktree directory but not the second, and the linter enumerates generated-output directory names while the bundler accepts any name. The third is 7 failing frontend tests caused by two files that transcribe their source module's contents as a literal expected value, detecting edits rather than defects.

**What is not in question.** The 14,657 test lines in services and database genuinely track a rejection-heavy specification with roughly 21 fail-closed reasons proven across five boundaries. That coverage stays. So does every security-sensitive boundary test the standard requires. This feature reduces how long coverage takes to run and how many lines it takes to express — never which behaviors are proven.

**Target outcome:** local gate 246s to roughly 110s, CI per merge from about 19 minutes to about 7, and zero gates failing on tooling artifacts.

## Tasks

| ID | Task | Scope | Depends on | Status |
|---|---|---|---|---|
| 001 | Capture a repeatable gate timing baseline | small | none | done |
| 002 | Stop running the same compilation twice | small | 001 | done |
| 003 | Stop the frontend bundler from re-running type checking | small | 001 | done |
| 004 | Restore incremental TypeScript compilation | small | 001 | done |
| 005 | Make every gate tool agree on what to ignore | medium | none | done |
| 006 | Clone the test database instead of migrating it every time | medium | 001 | done |
| 007 | Run independent gate phases concurrently | medium | 002, 003, 004 | done |
| 008 | Stop CI running the same verification twice | medium | 004 | **blocked** |
| 009 | Add a fast verification lane for the inner loop | medium | 006, 007 | todo |
| 010 | Replace mirror tests with invariant assertions | medium | none | done |
| 011 | Separate tooling self-tests from the product test gate | small | 005 | done |
| 012 | Codify what the audit learned in the testing standard | medium | 010, 011 | todo |
| 013 | Consolidate the rejection matrix into table-driven coverage | large | 012 | todo |

## Build Order

Task 001 comes first and gates most of the performance work, because every task after it claims a specific time saving that needs to be provable rather than assumed.

Tasks 002, 003, and 004 remove duplicated execution and are independent of each other. They precede 007 deliberately: parallelizing duplicated work would hide the waste instead of removing it.

Tasks 005 and 010 have no dependencies and can start immediately alongside 001. Together they resolve all three currently-failing gates, which is the highest-value early outcome — until they land, nobody can get a clean signal from the gate at all.

Task 012 depends on 010 and 011 so that the standard documents patterns already present in the codebase as working examples rather than describing an aspiration. Task 013 depends on 012 so the consolidation is done against a written rule.

Task 013 is the largest and least specified. It begins with a survey rather than edits, because the per-file repetition analysis has not been completed. Treat its scope as provisional until that survey exists.

## Parallel Groups

- **Group A** (no deps): 001, 005, 010
- **Group B** (after A): 002, 003, 004, 006, 011
- **Group C** (after B): 007, 008, 012
- **Group D** (after C): 009, 013

## Safety Constraints

These apply to every task in this feature and override any local optimization:

- The canonical full gate remains the definition of done at handoff. Tasks 009 and 011 add narrower paths for the inner loop; neither replaces the full gate.
- Security-sensitive boundary coverage is untouchable: authentication, sessions and cookies, authorization and tenant isolation, request validation, secrets and tokens, destructive actions, rate limiting, external writes, and audit behavior.
- Per-test database isolation is a correctness property, not a performance detail. Task 006 must preserve it exactly.
- No task deletes a test to make a lane faster. Tasks 010 and 013 change how coverage is expressed; task 011 changes when a lane runs. The set of proven behaviors does not shrink.

## Build Status

Ten of thirteen tasks are complete, one is blocked on a repository setting, and
two remain deliberately unstarted.

Measured against the committed baseline in `docs/gate-timing-baseline.json`:

| Phase | Baseline | Now |
|---|---|---|
| lint | 13.3s | 8.4s |
| typecheck | 28.1s | 13.1s |
| test (product lanes) | 94.3s incl. tooling | 21.4s |
| test:tooling | — | 40.6s, on demand |
| build | 65.8s | ~54.5s |

`npm run verify:framework` passes end to end: 348.4s on `origin/main` versus 269.3s on this branch, cold caches both (a 23% reduction). See the correction in task 001 — the earlier "206.5s to 164.6s" claim compared a sum of 33 separate invocations against one chained run and omitted `check:prisma`.

**Task 008 is blocked, not deferred.** `main` has no branch protection, so the
push-to-main workflow run is the only thing verifying `main`. Removing it to
deduplicate would delete verification rather than halve it. Caching and
run-cancellation shipped; the deduplication needs branch protection enabled
first. The task file records the exact two-step sequence.

**Tasks 009, 012, and 013 are not started.** 012 rewrites the canonical testing
standard and 013 is the large consolidation that begins with a survey that does
not exist yet. Both were held back rather than rushed.

Three findings from the build worth carrying forward:

- **Parallelising the test lanes made them four times slower** (21.4s to 88.2s).
  `node --test` already runs a process per file, so the lanes are internally
  parallel and stacking them thrashes. Task 009 should narrow which lanes run,
  not run more at once.
- **A single timing number against a stored baseline can mislead.** Task 003
  first appeared to make the build slower; a controlled A/B showed a 13.4s
  saving. The apparent regression was machine contention.
- **The line-saving estimate for task 010 was wrong** — 262 lines became 281, not
  the predicted 60. The win was decoupling tests from copy, not volume.

## Next Steps

For implementation-level detail — the specific scripts, configuration, and database helper changes — run `tasks-to-tech-specs` on this folder. This feature has no user-facing surface, so `tasks-to-ux-specs` does not apply.
