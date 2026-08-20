# Task: Make every gate tool agree on what to ignore

**ID:** test-overhead-reduction/005
**Depends on:** none
**Blocks:** test-overhead-reduction/011
**Estimated scope:** medium
**Status:** done

## Objective

The verification gate stops failing on files that are not part of the codebase — agent worktrees and generated bundler output — by giving every tool one shared definition of what to skip.

## Context

The verification gate currently cannot pass on a clean checkout, and two of the three failures are tooling artifacts rather than product defects. Both come from the same root cause: each tool maintains its own ignore list, and those lists have drifted apart.

**Agent worktrees.** The repository contains two separate worktree locations. Every gate script skips the first. None skips the second, which currently holds 8.4 GB across five checkouts. The dependency checker and the standards scanner both report findings for lockfiles inside those worktrees — four findings each, all false. The tools also walk that 8.4 GB on every run, which is pure wasted I/O.

**Generated bundler output.** The linter's ignore list enumerates specific generated-output directory names. The frontend's bundler configuration accepts *any* directory name through an environment variable, so verification runs that set a custom name create directories the linter then tries to lint. Two such directories exist right now, and linting them produces 14 errors in generated webpack code. Six generated-output directories exist in total; two do not match the enumerated list.

The test runner already handles this correctly, using a prefix test rather than an enumerated list. The fix is to make every tool as correct as the test runner, and ideally to make that correctness shared rather than repeated.

## Requirements

- No tool in the verification gate reports findings originating inside an agent worktree directory, in either worktree location.
- No tool in the verification gate reports findings inside generated bundler output, regardless of what the output directory is named.
- Ignore rules are defined once and consumed by every tool that needs them, rather than being copied into each tool. If a tool's configuration format genuinely cannot import shared logic, the duplication is explicit and documented rather than accidental.
- Matching is by pattern or prefix, not by an enumerated list of known names, so a newly-created output directory or worktree is covered automatically.
- Real findings are still reported: files inside the actual source tree must not be newly excluded as a side effect.
- Tools no longer traverse the ignored directories, so the wasted I/O goes away along with the false findings.

## User-Facing Behavior

A developer or agent running the gate on a checkout that contains worktrees and leftover build output sees no findings from those directories, and the checks complete faster because they are no longer walking them.

## Interface Contract

Exposes a single shared definition of ignored directories that the boundary checker, dependency checker, docs checker, standards scanner, test runner, and linter all consume. Task 011 changes how the test runner's lanes are grouped and must not have to redefine these rules.

## Acceptance Criteria

- [x] The dependency checker reports zero findings on a checkout containing agent worktrees in both locations.
- [x] The standards scanner ratchet reports zero new findings on the same checkout.
- [x] The linter reports zero errors from generated bundler output, including from a directory whose name is not in any enumerated list.
- [x] A deliberately-introduced real violation inside the source tree is still reported by the relevant tool.
- [x] Ignore rules are defined in one place and consumed by the tools rather than independently restated.

## Verification

With agent worktrees present and at least one custom-named generated output directory present, run the full framework check group, the standards ratchet, and the lint phase: all three exit 0. Then introduce a real violation of each kind inside the source tree — a nested lockfile and a lint error — and confirm the corresponding tool still exits non-zero.
