# Build from Tasks — Phased Delivery and Stacked PRs

Read this file whenever a feature has more than one delivery phase, or when the legacy phase-boundary review determines that one PR would be too large.

## Canonical Phase Model

The feature `_index.md` owns the delivery plan. Each numbered task owns implementation state; GitHub owns live PR state.

Use these phase states in the index:

- `planned`: no implementation is active for the phase.
- `building`: implementation or phase verification is active.
- `published`: a ready-for-review PR is open for the verified phase.
- `merged`: the phase PR landed on its intended target.
- `blocked`: a genuine prerequisite or external condition prevents progress.

Do not copy approval or merge state into task `Status`. A task is `done` once its acceptance criteria, specs, and verification pass on the committed owning phase head. If review feedback invalidates that evidence, return the affected task to `in_progress`, uncheck invalid criteria, and verify again.

Every phase record needs:

- a stable ID such as `P01`
- one reviewable outcome
- its owned task IDs
- semantic prerequisite phases
- its planned PR relationship
- a phase-local verification gate
- the safe state after merge
- a review budget and any approved size exception

Once work starts, also record the workflow-owned branch, direct parent SHA used for verification, verified implementation commit, and PR URL in the phase details. Query GitHub for current PR state instead of trusting a stale markdown label.

## Stack-Suitability Gate

Use separate phase PRs when there are two or more independently reviewable, merge-safe slices. A phase is suitable for separate publication only when it:

- builds and passes its checks at its own head
- preserves existing behavior, permissions, tenant isolation, and data integrity if merged alone
- exposes a stable interface to descendant phases
- does not need a later phase to repair an incomplete or unsafe state
- has a phase-local diff a reviewer can understand in one sitting

A dormant schema, service boundary, worker primitive, or adapter contract can be a valid phase when it is useful, tested, and safe before activation. Do not invent a public feature flag, compatibility shim, dual read, dual write, or provider-specific branch merely to make a phase stackable.

Use one atomic phase when separate merges would break builds or runtime invariants, weaken security, split an inseparable schema/data migration, separate source from required generated output, violate repository branch policy, or add ceremony to an already small focused change. If that phase exceeds the normal review budget, require an explicit size exception in `_index.md`; do not quietly publish a monolith.

## Review-Size Gate

Before implementation, estimate each phase against its review promise. Before publication, measure the real phase-local diff against its direct base.

Default target:

- one reviewer thesis
- up to three coherent tasks
- no more than two primary runtime surfaces
- about one to two implementation days including focused verification
- no more than roughly 2,500 authored changed lines across 25 authored files

Crossing the target triggers a boundary review. Split the phase when a stable merge-safe boundary exists. Between the target and the hard stop, an inseparable phase may proceed only after its rationale is recorded in the phase details.

Do not publish a phase above 5,000 authored changed lines or 40 authored files unless the user explicitly approves the size exception after seeing the measured diff and the reason it cannot be split safely.

Tests and migrations are authored changes. Report lockfiles, vendored content, and objectively generated output separately. Generated volume is not a reason to mix unrelated authored work, but required generated output stays with the source change that produces it. Risk can require a smaller phase even when line and file counts are low.

Before trusting a phase-only comparison, require the observed direct-base head to be an ancestor of the phase head. Then inspect both the two-dot tree diff and the child-only commit range against that exact base, plus the PR's rendered diff. A three-dot diff can look phase-clean while the child is missing a newer parent commit, so it is never sufficient by itself.

For example, validate the equivalent of:

```text
git merge-base --is-ancestor <observed-base-sha> <phase-head>
git diff --stat <observed-base-sha>..<phase-head>
git log <observed-base-sha>..<phase-head>
```

The phase-only comparison—not the cumulative default-branch comparison for a child—is what determines review size.

## PR Topology

Resolve the repository's actual default branch instead of assuming `main`.

### Root phase

Branch the first phase from the resolved default branch and target that branch in its PR.

```text
default branch
└── codex/<feature>-p01-<slug>
```

### Linear stack

When `P02` semantically needs unmerged `P01`, create `P02` from the exact committed and verified `P01` head. Target the `P02` PR at the `P01` branch so its review diff contains only `P02` work.

```text
default branch
└── codex/<feature>-p01-<slug>
    └── codex/<feature>-p02-<slug>
        └── codex/<feature>-p03-<slug>
```

Create phase worktrees at `.worktrees/<feature>-pNN-<slug>` by default. The repository's instructions or user-specified naming overrides these examples.

Open dependent child PRs for review, but merge the stack base-most first. Never merge a child PR into an unmerged parent phase branch; that would contaminate the parent's review diff.

### Sibling phases

When two phases share a stable prerequisite but can merge in either order, create siblings from the same verified parent. Do not invent adapter-to-adapter dependencies just to force a linear stack.

```text
codex/<feature>-p01-contract
├── codex/<feature>-p02-provider-a
└── codex/<feature>-p03-provider-b
```

If the shared prerequisite is still open, sibling PRs may target its branch for review. After it lands, safely restack and retarget each sibling to the real target before merging either sibling.

### Multiple prerequisites

A GitHub PR has one base branch. When a later phase needs multiple sibling phases, prefer one of these plans:

1. Wait for the sibling phases to merge, then branch the integration phase from the updated default branch.
2. Redraw the phases as a meaningful linear stack when the later phase truly benefits from cumulative review.
3. Use a disposable local aggregate branch for full-stack verification only; never publish it as a catch-all PR.

Do not create an ad hoc merge branch that obscures phase ownership. If new cross-sibling wiring is required, give that work its own planned integration phase after the prerequisites.

## Phase Lifecycle

For each phase, in dependency order:

1. Reconcile the canonical plan with existing worktrees, local and remote branches, PRs, and merge bases. Reuse valid work; do not create duplicate branches or PRs.
2. Create or enter the phase worktree from the declared direct base. Make sure the canonical `.tasks` artifacts are present on the branch before changing task status. If they exist only as uncommitted changes in the primary checkout, transfer only the feature's task artifacts; do not stash, reset, or commit unrelated user changes.
3. Mark the phase `building`, then claim only its owned tasks. Implement dependency groups within the phase and keep subagent write scopes disjoint.
4. After each task group, run task verification anchors, affected predecessor/interface tests, companion-spec checks, and the focused repository guardrail. Update task files only from observed evidence.
5. Run the phase merge gate, inspect the phase-local diff, and apply the review-size gate. Fix cross-task wiring inside the phase; move a cross-phase fix to the earliest phase that owns the invariant.
6. Deploy and drive the phase runtime flow when it has a runnable surface. For a dormant foundation, record contract or integration evidence and name the later phase that owns full end-to-end proof.
7. Commit the verified phase and record its direct parent SHA and verified implementation commit. Push its workflow-owned branch and open one ready-for-review PR against the declared base.
8. Validate the live PR's head, base, draft state, and phase-only diff. Record the branch and PR URL in `_index.md`, set the phase to `published`, commit that delivery-only tracker update on the phase branch, and push it. This metadata-only commit does not invalidate implementation verification unless repository checks include task files; rerun those checks when they do.
9. Start a descendant only from the latest committed and verified parent head. Publish a verified phase before starting another unpublished phase on the same stack chain.

Cap open dependent stack depth at three by default. Pause new descendants when the base-most open phase is volatile, has requested changes, or has an unstable interface. Independent sibling work may continue in separate worktrees when its shared prerequisite remains stable.

At the top of a linear stack, run the cumulative feature integration, local deploy, and end-to-end verification. For sibling graphs, use the planned post-merge integration phase or a disposable local aggregate to prove combined behavior; apply fixes to their owning phase branches and rerun the aggregate.

## PR Content and Validation

Use titles that expose stack position, for example `[Stack P02/P04] Admin promotion controls`.

Each PR body includes:

- phase ID, review promise, and owned task IDs
- direct base branch, verified parent SHA, parent PR, and child PR links when known
- phase-only scope and behavior deliberately deferred to later phases
- focused verification, framework guardrail, deploy evidence, and deferred cumulative checks
- authored and generated diff summaries, size exception if any, and expected merge order

Before reporting a PR, confirm it is ready for review and that its live base/head match the plan. Fetch the current base, require that exact head to be an ancestor of the child, and inspect both the two-dot tree diff and child-only commit range. Compare the phase against its direct base so a child PR does not present the cumulative feature diff.

## Upstream Changes and Restacking

When review feedback changes an earlier phase:

1. Put the fix in the earliest phase that owns the affected contract or behavior. Never duplicate the same fix independently in descendants.
2. Fetch remote state, record immutable old branch and remote SHAs, and confirm the phase branches are workflow-owned and contain no unexpected external commits. Keep a local backup ref until the rewritten stack verifies.
3. Commit and push the parent fix, then restack descendants in topological parent-before-child order. For each edge, replay the child's phase-owned commits from its saved old-parent SHA onto the new-parent SHA. Siblings replay onto the same semantic parent, never onto one another.
4. Re-run every affected descendant's task anchors, interface checks, phase gate, and diff-size check. Previous verification is stale when the verified parent SHA changes.
5. Confirm the current direct base is an ancestor of each child and that both its two-dot tree diff and child-only commit range contain only its owning phase.

Keep phase-owned history linear by default so replay boundaries stay unambiguous. If a phase deliberately contains merge commits, preserve them with the repository's merge-aware rebase procedure, such as `--rebase-merges`, and validate the resulting ancestry and commit ownership before pushing.

Use `--force-with-lease`, never plain `--force`, only when restacking a workflow-owned published branch requires rewriting it. Prefer an explicit lease tied to the remote SHA observed immediately after fetch, equivalent to `--force-with-lease=refs/heads/<branch>:<observed-remote-sha>`, so a background fetch cannot weaken the lease. If another contributor has added commits, stop before rewriting and ask for coordination. Do not merge a child upward into its parent.

After a parent PR merges, fetch the target and inspect whether the repository used merge, squash, or rebase semantics. Preserve the full old-parent SHA before its ref is changed or deleted. Replay only child-owned commits from that saved boundary onto the new target, verify ancestry and phase-only ranges locally, push safely, and only then retarget the PR. Propagate the old/new boundary pair through later descendants in topological order and re-verify before merging.

If a parent PR closes without merging, mark descendants delivery-blocked and ask for direction. Do not retarget them to the default branch, because that can silently resurrect changes the closed parent owned.

If repeated conflicts show a phase boundary is wrong, redraw unpublished phases. Ask before closing, combining, or materially rewriting already published PRs.

## Resume

On a resumed build:

1. Read phase and task records.
2. Inspect worktrees, dirty state, local/remote heads, open and closed PRs, PR bases, and merge bases.
3. Reconcile markdown state to committed code and live PR facts; preserve unrelated user work.
4. Resume the base-most unfinished or review-invalidated phase first.
5. Restack and retarget an immediate child after its parent merges before continuing later work.

Do not trust a prior verification note when implementation, tests, acceptance evidence, or the verified parent SHA changed. A delivery-record-only commit may follow the verified implementation commit without invalidating code evidence unless repository checks include task files. Do not create a replacement PR until confirming that an existing PR for the phase is unusable.

## Stack Review Watch

Use one read-only watcher for all open phase PRs and prioritize the base-most phase.

- Approval is phase-specific; one approval or 👍 never approves the entire stack.
- Review feedback lands on the owning phase branch and triggers descendant restacking when ancestry changes.
- Reply to each inline thread with the fix commit and one-line resolution; summarize non-inline feedback in a PR comment.
- A parent merge triggers immediate child retarget/restack work by the orchestrator.
- A parent closure without merge blocks descendants pending user direction.
- The delivery is fully merged only when every intended phase is merged or explicitly withdrawn.

Keep PR numbers, last-seen review/comment identifiers, branch heads, and phase relationships in the watcher brief so a resumed watch does not process old feedback twice.
