# Task: Stop CI running the same verification twice

**ID:** test-overhead-reduction/008
**Depends on:** test-overhead-reduction/004
**Blocks:** none
**Estimated scope:** medium
**Status:** todo

## Objective

A merge costs one verification run instead of two, and that run reuses cached compilation and bundler output instead of starting cold, cutting continuous integration time roughly in half.

## Context

The repository's verification workflow triggers on both pull requests targeting the main branch and pushes to the main branch. A pull request therefore runs the complete gate, and the resulting merge commit runs the identical gate again against effectively the same tree.

Measured cost across the last fifteen workflow runs: approximately 134 minutes total, with individual runs ranging from 1.6 to 10.5 minutes and most clustering near 10 minutes. Roughly half of that total is re-verification of commits that already passed on their pull request.

Separately, the workflow caches only the package manager's download cache. It does not cache the bundler's build cache or TypeScript's incremental compilation state, so the 62-second frontend production build starts completely cold on every run, as does every type check.

This task depends on task 004 because incremental compilation must be enabled before caching its state has any effect.

The safety consideration is real and must be handled deliberately: dropping push verification entirely means a merge commit is never verified as merged. Where a merge could produce a tree that neither parent had — a semantic conflict that merges cleanly but breaks — something must still catch it. The requirement below is to keep main protected while not paying twice for the identical tree.

## Requirements

- A pull request and its resulting merge commit do not both run the full gate against an equivalent tree.
- The main branch remains protected: a tree that has never been verified must not land unverified. The chosen approach for guaranteeing this is documented alongside the workflow.
- Bundler build cache and TypeScript incremental state are cached across runs and restored on subsequent runs.
- Cache keys invalidate correctly when dependencies or compiler configuration change, so a stale cache cannot produce a false pass.
- A way exists to force a clean, cache-free verification run when a result is in doubt.
- The workflow's existing service dependencies and environment configuration continue to work unchanged.
- The timeout remains appropriate for the new, shorter expected duration.

## User-Facing Behavior

A developer opening a pull request sees verification complete faster than today, and merging it does not trigger a second full-length run.

## Interface Contract

The workflow continues to invoke the canonical verification command rather than reimplementing the gate, so improvements from tasks 002 through 007 flow into CI automatically without further workflow changes.

## Acceptance Criteria

- [ ] A pull request and its merge commit together consume roughly one gate run, not two.
- [ ] Main branch protection is preserved — an unverified tree cannot land.
- [ ] Bundler and TypeScript caches are saved and restored across workflow runs.
- [ ] A second run on an unchanged tree is measurably faster than the first due to cache reuse.
- [ ] Changing a dependency or compiler configuration invalidates the relevant cache.
- [ ] A clean, cache-free run can still be triggered on demand.

## Verification

Open a pull request and confirm the gate runs and exits 0; merge it and confirm a second full gate run is not triggered against the equivalent tree. Compare two consecutive workflow runs on the same branch and confirm the second is measurably faster with cache restore reported in the logs. Confirm a dependency change produces a cache miss rather than a stale hit.
