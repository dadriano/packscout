# Task: Stop CI running the same verification twice

**ID:** test-overhead-reduction/008
**Depends on:** test-overhead-reduction/004
**Blocks:** none
**Estimated scope:** medium
**Status:** blocked

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
- [x] Main branch protection is preserved — an unverified tree cannot land.
- [x] Bundler and TypeScript caches are saved and restored across workflow runs.
- [ ] A second run on an unchanged tree is measurably faster than the first due to cache reuse.
- [x] Changing a dependency or compiler configuration invalidates the relevant cache.
- [x] A clean, cache-free run can still be triggered on demand.

## Verification

Open a pull request and confirm the gate runs and exits 0; merge it and confirm a second full gate run is not triggered against the equivalent tree. Compare two consecutive workflow runs on the same branch and confirm the second is measurably faster with cache restore reported in the logs. Confirm a dependency change produces a cache miss rather than a stale hit.

## Spec Compliance

- Related specs reviewed: none (no companion specs exist for this feature)
- Alignment: partially implemented. **Status is `blocked`, not `done`** — the
  headline requirement depends on a repository setting that cannot be changed
  from a branch.

### The blocker

The task requires that a pull request and its merge commit not both run the full
gate, *while* guaranteeing an unverified tree cannot land on `main`.

`main` has no branch protection:

```
gh api repos/dadriano/packscout/branches/main/protection
-> 404 Branch not protected
```

Nothing therefore requires this check to pass before a merge, and nothing
requires a branch to be up to date with `main` first. **The push-to-main run is
currently the only thing verifying `main` at all.** Removing it would not
deduplicate verification; it would delete it, and a merge that produced a broken
tree — a semantic conflict that merges cleanly — would land unnoticed.

The trigger was therefore left in place. Halving the per-merge cost is a real and
available win, but it is gated on a decision only the repository owner can make.

### To unblock

1. Enable branch protection on `main` with **Require status checks to pass**
   (select `Verify framework standards`) and **Require branches to be up to date
   before merging**. The second setting is the one that matters: it guarantees the
   tree a pull request verified is the tree that lands.
2. Then remove the `push: branches: [main]` trigger from the workflow and drop
   the explanatory comment above it.

That sequence preserves the guarantee at every step. Doing step 2 first does not.

### What was implemented

- **Build caching.** `apps/frontend/.next/cache`, `.next-build/cache`, and every
  `*.tsbuildinfo` are saved and restored. Without this the 47–62s webpack build
  and every type check start cold on each run, which is why task 004 restoring
  incremental compilation has no effect in CI on its own.
- **Cache keys invalidate correctly.** The key covers the lockfile, every
  `tsconfig.json`, and `next.config.ts`, so a dependency or compiler
  configuration change misses rather than restoring stale state. `restore-keys`
  fall back progressively so an unrelated change still gets a warm-ish start.
- **Superseded runs are cancelled.** A `concurrency` group cancels in-progress
  runs for the same pull request, so pushing twice to an open branch costs one
  gate run instead of two. Runs on `main` are never cancelled, since each
  verifies a commit that actually landed. This is a genuine saving that needed no
  safety trade.
- Services, environment, and the 20-minute timeout are unchanged.

### Unverified criteria

Two acceptance criteria cannot be checked from a local branch and are left
unticked deliberately:

- that a pull request and its merge commit consume roughly one run — blocked as above;
- that a second run on an unchanged tree is measurably faster from cache reuse —
  this needs two real workflow runs to observe. The cache configuration is
  correct by construction but is not yet evidenced.

### Verification

- Workflow parses as valid YAML; triggers, `concurrency`, the cache step, the
  Postgres service, the environment, and the final `verify:framework` step all
  confirmed present after the edit.
- `npm run check:framework` — exit 0 with the revised workflow in place.

## Post-merge CI evidence: the cache restores but delivers nothing

Two CI runs now exist, and together they settle both open criteria — one
positively, one negatively.

### The cache does save and restore (criterion met)

Run 32391979167 was cold and missed at every key level. Run 32393563155 hit:

```
Restore build caches  Cache hit for restore-key: build-Linux-node22-442b14f1...-d310974a...-568037b2...
Restore build caches  Cache Size: ~58 MB (60594994 B)
Restore build caches  Cache restored successfully
```

The `restore-keys` ladder works as designed. The primary key embeds
`github.sha` deliberately: `actions/cache` only saves when the primary key
misses, so a per-commit key is the standard idiom for a cache that must refresh
every run, with `restore-keys` doing the actual restoring by prefix.

### But it buys nothing, and the reason is the build script

| Run | Verify step | Job total |
|---|---|---|
| 32391979167 (cold cache) | 5m09s (309s) | 7m42s |
| 32393563155 (warm cache) | **5m03s (303s)** | 7m36s |

Six seconds. Within noise.

The cause was confirmed by experiment rather than inference. A marker file was
planted in `apps/frontend/.next-build/cache`, `npm run build:frontend` was run,
and the marker was gone afterwards.

The frontend build script is:

```
rm -rf .next-build && NEXT_DIST_DIR=.next-build next build --webpack
```

It deletes its entire output directory — including `cache/`, which is where
webpack's incremental cache lives — before the build starts. The restored cache
is removed moments after being restored. The 58 MB that CI saves is whatever the
build regenerated *after* wiping, which the next run then wipes again.

So the second acceptance criterion, that a repeat run is measurably faster from
cache reuse, is **not met**, and the reason is not the cache configuration.

### The fix, and why it was not made here

Preserving only `cache/` across the clean is safe: webpack's cache is
content-addressed and cannot produce stale build output, and persisting
`<distDir>/cache` is what Next.js documents for CI. Everything else in the
directory would still be removed, keeping the clean-build guarantee the `rm -rf`
exists to provide.

This was left undone deliberately. It modifies the production build script,
which is outside this task's stated scope, and it deserves its own verification
cycle — a cold-versus-warm frontend build measurement proving the preserved
cache is actually consumed. Shipping it untested at the end of this branch would
repeat the mistake this task file already documents once: reporting a saving
that measurement had not established.

Until it is fixed, the caching in this workflow is honest infrastructure that is
not yet paying for itself. It costs 26s to restore and 42s to save per run,
which is currently a net loss of roughly a minute.

### Correction: the fix is worth less than the section above implies

A step-level breakdown of run 32393563155 bounds the upside, and it is smaller
than "the build wipes its cache" suggests on its own. Within the 303s verify
step:

```
contracts     start 16:46:12
database      16:46:17 -> 16:46:45
services      16:46:46 -> 16:47:57
Next build    16:48:46 -> 16:49:41   (~55s)
```

The build is roughly **55s of 303s**. The verify step is dominated by the test
lanes, not by bundling. So even a perfectly working webpack cache caps out
somewhere under 40s of savings, against a 68s cost to restore and save
(26s + 42s). Fixing the `rm -rf` would move the caching from a net loss to
roughly break-even, not to a large win.

Both facts are true and neither alone is the whole picture:

- The restored cache is deleted before webpack can read it — proven by planting
  a marker file, running the build, and finding it gone.
- Even intact, it would not have transformed the run, because the bundler is not
  where this gate spends its time.

The second point is the one that should drive the decision. Reported Next
compile times were 49s cold and 47s warm, consistent with the cache being wiped
in both runs and the 2s being noise.

**Recommendation:** treat the build cache as provisional. Either fix the `rm -rf`
and re-measure to confirm it clears its own overhead, or drop the cache step
entirely and reclaim the 68s it currently costs. Keeping it unfixed is the worst
of the three options. `*.tsbuildinfo` is worth keeping in the cache either way,
since it is nearly free to store and typecheck runs on every gate.

This also revises a claim made earlier in this feature: task 004 restoring
incremental compilation was said to have "no effect in CI without this caching".
That remains true in principle, but the effect is small in practice, because
typecheck is around 13s of the gate.
