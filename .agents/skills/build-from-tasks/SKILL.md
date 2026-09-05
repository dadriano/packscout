---
name: build-from-tasks
description: Execute buildable tasks from a .tasks/ folder using dependency planning, reviewable delivery phases, stacked or sibling PRs, canonical .tasks status updates, isolated worktrees, parallel subagents when appropriate, and full publish handoff. Use when a project has already been decomposed into task files and implementation is ready to begin. Trigger with /build-from-tasks.
---

# Build from Tasks

Read the `.tasks/` folder and execute task files while respecting dependency order, delivery-phase boundaries, repository conventions, and the canonical `.tasks` tracker.

Preserve this operating model:

- read the task plan first
- respect dependency groups
- publish one independently reviewable phase per PR instead of accumulating the entire feature in one branch
- stack genuinely dependent phases and use sibling PRs for independent phases with a shared prerequisite
- isolate work when possible
- track task status directly in the canonical `.tasks` files
- integrate and verify after each dependency group and delivery phase
- treat phase commit, push, PR creation, stack maintenance, deploy, and the post-PR review watch as part of completion, not optional cleanup

## Task Structure

Tasks typically live under a feature folder:

```text
.tasks/
├── feature-name/
│   ├── _index.md
│   ├── 001-task-name.md
│   ├── 002-task-name.md
│   ├── tech-001-contract.md
│   ├── ux-001-flow.md
│   ├── mockups/
│   │   ├── ux-flow.html
│   │   └── figma-handoff.md
│   └── ...
```

Task IDs use the format `feature-name/NNN`.

Tasks describe goals and outcomes, not exact file paths. The builder should read the repository instruction file and explore the codebase before implementing.

Companion specs may live beside task files as `tech-*.md` or `ux-*.md`. Technical specs are implementation guidance produced by `tasks-to-tech-specs`; UX specs are design guidance produced by `tasks-to-ux-specs`. Optional UX mockup artifacts may live under `.tasks/<feature>/mockups/`. None of these companion files are runnable tasks.

## Canonical Source of Truth

Do not depend on external Ralph-style helpers as part of this workflow.

The canonical state lives in the `.tasks` files themselves:

- the feature `_index.md`
- each task markdown file

Use those files directly to:

- determine dependency order
- find runnable tasks
- track `todo`, `in_progress`, `done`, and `blocked`
- decide which groups are ready for integration or deploy
- map every task to its owning delivery phase
- track planned phase relationships and published phase records

Exclude `tech-*.md`, `ux-*.md`, and files under `.tasks/<feature>/mockups/` from canonical task state. Do not parse them as runnable tasks, do not add them to `_index.md`, and do not update task status in them.

If helper scripts exist, they may be convenient for local execution, but they are not required and must not be treated as the workflow's source of truth.

Task state and delivery state are separate:

- `done` means a task's acceptance criteria, related specs, and verification passed and are committed on its owning phase head. It does not mean the PR is published, approved, or merged.
- Phase delivery state uses `planned`, `building`, `published`, `merged`, or `blocked` in `_index.md`.
- Waiting for review on a published prerequisite is not a blocked task.

## Delivery Phase Contract

A task is a build unit. A dependency group is an execution-order or concurrency unit. A delivery phase is a review, branch, verification, and PR boundary.

When `_index.md` contains `## Delivery Phases`, treat it as the default maximum PR scope:

- Every runnable task must belong to exactly one phase.
- Do not implement work from a later phase on an earlier phase branch.
- Publish each verified phase before accumulating later phase work on the same branch.
- A phase may be split further when its real diff is too large. Do not combine planned phases without explicit user approval.
- A phase must compile, pass its merge gate, preserve security and data integrity, and be safe to merge against its direct PR base without later phases.

For a multi-phase feature, read [stacked-prs.md](stacked-prs.md) before `plan`, `build`, `next`, `resume`, `integrate`, or publish work. It defines stack topology, phase worktrees, review-size gates, restacking, and stack-wide review handling.

For a legacy feature with no delivery plan, perform a phase-boundary review before editing code. Add an implicit `P01` only when the whole remaining feature is demonstrably small, cohesive, and merge-safe. Otherwise add dependency-closed phases to `_index.md` without changing product outcomes or renumbering tasks. Stop for user direction if safe interim merge behavior requires a new product, migration, compatibility, or rollout decision.

## Companion Specs

When a feature folder contains `tech-*.md`, `ux-*.md`, or `.tasks/<feature>/mockups/` files, treat them as companion guidance that must be reviewed before building related tasks.

Companion spec rules:

- Discover all `tech-*.md` and `ux-*.md` files in the feature folder before `plan`, `build`, `next`, `resume`, explicit task or phase, and `integrate` modes.
- Discover `.tasks/<feature>/mockups/` artifacts during the same modes when they exist, especially for UI tasks that reference related UX specs.
- Match specs to tasks through the `**Related tasks:** feature/001, feature/003` line.
- Read specs related to a task before implementation or subagent handoff.
- Read all feature-level companion specs during planning and integration. Use tech specs for shared write scopes, sequencing risks, contracts, database changes, endpoints, and verification expectations. Use UX specs and mockups for user flows, information architecture, layout, states, accessibility, content, visual direction, and review expectations.
- Exclude `tech-*.md`, `ux-*.md`, and `.tasks/<feature>/mockups/` files from runnable task discovery, dependency parsing, task numbering, task status updates, `_index.md` status sync, and acceptance-criteria checkbox updates.
- Treat task files, current repository facts, and current product/design-system standards as authoritative when they conflict with a companion spec.
- Record any intentional divergence from a related companion spec before marking a task `done`.

If a companion spec references Convex implementation details or Convex-driven UX behavior and the repository contains `convex/_generated/ai/guidelines.md`, read that guideline file before changing Convex code.

## Execution Checklist

Mirror active build progress using the current harness's available plan/checklist tool. If it has no such tool, maintain a concise checklist in progress messages. The `.tasks` files remain the canonical source of truth. The checklist is a live execution view for the user, not a replacement tracker.

Checklist rules:

- After reading the feature `_index.md`, the relevant task files, and the repo instructions, create or update todos so progress appears early in the run.
- Default to one checklist item per delivery phase, with the active phase's current dependency group named in its text. Do not call dependency groups "phases."
- Keep exactly one checklist item `in_progress` at a time.
- Mark a phase checklist item complete only after its phase gate passes and its PR is published, or after the explicitly requested code-only stop point is reached.
- When a task or dependency group finishes, update the active phase item promptly; when a phase publishes, move to the next actionable child or sibling.
- If work is paused on an external dependency or unresolved failure, reflect that in the explanation and keep the next actionable item pending until the blocker is cleared.
- Keep the checklist synchronized with the real `.tasks` status. If they diverge, fix the `.tasks` files first and then refresh the checklist.
- In short runs for a single task, a compact checklist is fine, for example: inspect, implement, verify, update tracker.

## Supported Modes

### `plan`

Show the full phased build and publish plan without editing code:

1. Read the feature `_index.md`, every task in scope, all feature companion specs, and the repository instruction source.
2. List every task with status, dependencies, owning delivery phase, related specs, and declared verification anchor.
3. If the index has no delivery phases, perform the legacy phase-boundary review and propose dependency-closed phases. Do not edit the index in `plan` mode.
4. Validate that each proposed phase is merge-safe, phase-closed, independently verifiable, and within the review-size target. Flag any product or rollout decision that prevents a safe boundary.
5. Distinguish task parallelism from PR topology. Show which tasks can run concurrently inside a phase and which independent phases are sibling PRs.
6. Resolve the actual default branch and inspect existing worktrees, branches, and PRs so the plan reuses valid state.
7. Show one worktree/branch per phase, each direct PR base, parent and sibling relationships, expected merge order, and the maximum open stack depth.
8. Show task, phase, cumulative integration, deploy, spec-compliance, and framework-standard gates. Include the review-size check at every publish boundary.
9. Include focused subagent briefs for low-conflict task groups within each phase. The orchestrator owns phase branches and publication.
10. Create todos at delivery-phase granularity, with the currently actionable phase first.

Preferred output shape:

```markdown
## Build Plan

P01 — Shared contract
  tasks: feature/001, feature/002
  branch: codex/feature-p01-contract
  PR base: <default branch>
  task groups: 001 and 002 can run in parallel
  phase gate: contract tests + framework verifier

P02 — Admin controls
  tasks: feature/003
  branch: codex/feature-p02-admin
  PR base: codex/feature-p01-contract
  relationship: stacked on P01
  phase gate: admin tests + runtime flow

P03 — Provider A adapter
  tasks: feature/004
  branch: codex/feature-p03-provider-a
  PR base: codex/feature-p01-contract
  relationship: sibling of P02

Cumulative integration:
  top of linear stack, or disposable local aggregate for siblings

Publish order:
  open each phase when verified; merge base-most first; never collapse into a final feature PR
```

Include a recommended subagent brief for each parallel task group based on the Worker Selection table below.

### `build`

This is the primary execution mode.

Always run `build` in dedicated phase worktrees so the user's primary checkout stays untouched. Use `.worktrees/<feature>-pNN-<slug>` and `codex/<feature>-pNN-<slug>` by default unless repository instructions or the user specify another convention.

1. Read the feature `_index.md`, repository instructions, every task in scope, and all related companion specs and mockups.
2. Inspect git state, resolve the actual default branch, and discover existing worktrees, local/remote phase branches, and PRs before creating anything.
3. Build the task dependency graph and delivery topology. Skip tasks already `done`, but verify that their commits are ancestors of the phase base that depends on them.
4. If the feature lacks phases, apply the legacy phase-boundary review and add a delivery plan to `_index.md` before implementation. Do not change product behavior to make a convenient stack.
5. Validate phase closure, safe interim merge states, PR relationships, and planned review size. Stop for user direction when a missing migration, rollout, or compatibility decision makes the split unsafe.
6. Create todos by phase, keeping exactly one current orchestration phase `in_progress`. Use subagents for compatible dependency-free tasks within that phase; do not give subagents independent control of stack branches.
7. Create or enter the current phase worktree from its declared direct base and mark the phase `building`. For a dependent phase, use the exact committed and verified parent head.
8. Claim only tasks owned by the phase. Before each task, mark it `in_progress`, read its related specs, and include its interface, acceptance, verification, and phase boundaries in any subagent brief.
9. Execute dependency groups within the phase. Parallelize low-conflict tasks; serialize overlapping write scopes and cross-task contracts.
10. After each dependency group:
    - review landed changes, `git status`, and the diff against the current phase base
    - resolve overlaps and integration issues without pulling later-phase work into the branch
    - run every task's `## Verification` anchor; when a legacy task has no anchor or declares `none (no runtime surface)`, run and record the most relevant fallback
    - run relevant group checks and the fastest repository framework guardrail
    - verify each acceptance criterion and related companion-spec expectation from evidence, then check it off
    - retry an incomplete handoff from current progress instead of restarting it
    - rerun the full task/group verification set after fixes
    - add or update `## Spec Compliance`, mark verified tasks `done`, and return interrupted work to `todo` or `blocked` accurately
    - commit a meaningful group checkpoint and refresh the checklist
11. At the phase boundary, run phase integration, all owned task anchors, affected predecessor/interface regressions, the declared phase gate, and the repository's required final verifier. Deploy and drive the phase flow when it has a runnable surface.
12. Measure the authored and generated phase-only diff against the direct PR base. Split an oversized phase before publication or follow the explicit size-exception rule in [stacked-prs.md](stacked-prs.md).
13. Commit the verified phase, record the direct parent SHA and verified implementation commit, push its workflow-owned branch, and open one ready-for-review PR against the planned base. Require the current direct-base head to be an ancestor of the phase head, then validate the live base/head plus phase-only tree and commit ranges; never trust a clean three-dot diff alone or let a child PR present cumulative feature work.
14. Record the branch and PR URL in the phase details, set the phase to `published`, commit and push the tracker update, and start the stack-aware review watch.
15. Continue with a child or sibling phase only under the stack-depth and stability rules. Create it from its declared verified base; never keep adding later phases to the published parent branch.
16. At the top of a linear stack, run cumulative feature integration, deploy, and end-to-end verification. For siblings, use the planned post-merge integration phase or a disposable local aggregate and put every fix back on its earliest owning phase branch.
17. Report every phase's task IDs, verification, deploy result, commit SHA, branch, direct base, and PR URL. Do not replace the phase PRs with a final monolithic feature PR.

Draft PRs remain opt-in. Open a draft only when the user asks or a stated blocker prevents review; otherwise every published phase PR is ready for review.

### `feature-name/NNN` or explicit task IDs

Execute specific tasks in their owning phase worktree:

1. Read each referenced task file.
2. Read the feature `_index.md`.
3. Discover and read each `tech-*.md` and `ux-*.md` file whose `Related tasks` includes the task ID.
4. Read the repo instruction file.
5. Identify the owning phase, direct base, existing worktree/branch, and other tasks sharing the phase. Do not place tasks from different phases in one branch.
6. Create or enter the owning phase worktree, explore relevant code, and mark the task `in_progress`.
7. Implement the task while following its interface contract, acceptance criteria, delivery context, and related companion specs. Do not pull later-phase behavior forward.
8. Run the task's declared `## Verification` anchor and require it to pass, then run the framework standards guardrail when the repository exposes one. If the task declares no anchor or declares `none (no runtime surface)`, run the most relevant verification and note what was run.
9. Recheck phase closure, add or update the task file's `## Spec Compliance` note, mark the task `done`, and report what was completed.
10. Do not publish the phase until every task it owns and its phase merge gate are complete, unless the user explicitly changes the planned phase boundary.

If explicit task IDs span phases, process phases in dependency order and keep a separate worktree/branch for each. Never combine them into a convenience PR.

### `Pxx` or explicit delivery phase

Execute one complete delivery phase through its publish boundary:

1. Read the index, all tasks owned by the phase, related companion specs, and repository instructions.
2. Reconcile or create the phase worktree at its declared direct base.
3. Execute the phase's internal dependency groups using the normal task and spec-compliance gates.
4. Run the phase verification, deploy/runtime check when applicable, and review-size gate.
5. Commit, push, open one ready-for-review phase PR, validate its direct base and diff, update the index, and start or resume the stack watcher.

### `next`

Find the next unfinished task group inside the base-most actionable delivery phase.

1. Read the feature `_index.md`.
2. Read task files that are not already `done`, excluding `tech-*.md` and `ux-*.md` files.
3. Discover companion specs and use related specs only to understand implementation guidance, UX guidance, and write-scope conflicts.
4. Read [stacked-prs.md](stacked-prs.md) when the feature has multiple phases, and reconcile existing phase branches and PR state.
5. Choose the base-most phase that is not `merged` and still has implementation or invalidated verification work. A published phase waiting only for review does not make its completed tasks runnable again.
6. Treat a task as runnable only if:
   - it is not `done`
   - it is not already `in_progress` unless the user is explicitly resuming it
   - every dependency listed in `Depends on` is `done`
   - it belongs to the selected phase
   - its required earlier phase head is committed and verified
7. If several tasks are independently runnable:
   - recommend a parallel group in `plan`
   - in `build`, proactively delegate them in parallel when parallel subagent work is in scope and the write scopes are low-conflict
8. If only one task is runnable, execute it directly or recommend it as the next step.
9. Start later sibling work only when the shared prerequisite is stable. Do not skip over requested changes or stale verification in an ancestor phase.

### `resume`

Resume a phased build without duplicating branches or PRs:

1. Read phase and task state, then inspect worktrees, dirty state, local and remote heads, open and closed PRs, bases, and merge bases.
2. Reconcile markdown state to committed code and live GitHub facts. Preserve unrelated user or collaborator changes.
3. Treat verification as stale when implementation, tests, acceptance evidence, or the recorded direct-parent SHA changed. A delivery-record-only commit does not invalidate implementation evidence unless repository checks include those files.
4. Resume the base-most unfinished or review-invalidated phase first.
5. If a parent merged, restack and retarget its immediate child before continuing later work. If it closed unmerged, mark descendants delivery-blocked and ask for direction.
6. Reuse an existing valid branch and PR. Do not open a replacement merely because the local tracker is stale.

### `integrate`

Run a phase-local or stack-wide integration pass:

1. Review completed tasks, delivery phases, live phase branches/PRs, and the feature index.
2. For a named or current phase, compare only against its direct base. Review related specs and confirm every owned task has accurate spec-compliance evidence.
3. Re-run the phase's task anchors, predecessor/interface regressions, app/build/typecheck/lint checks, phase gate, framework guardrail, and applicable runtime flow.
4. Fix cross-task wiring, broken imports, contract mismatches, spec mismatches, and regressions on the earliest phase branch that owns them. Do not hide an upstream defect in the top phase.
5. For a linear stack, run full integration and end-to-end behavior on the top verified phase head. For sibling phases, use the planned post-merge integration phase or a disposable local aggregate; never publish the aggregate as a catch-all PR.
6. When an upstream fix changes ancestry, restack and re-verify affected descendants oldest-to-newest.
7. Update task state, spec-compliance notes, phase records, and verification SHAs to match observed results.

### `deploy`

Start the affected services from the current worktree using the repository's actual local-development commands:

1. Inspect root and workspace `package.json` scripts, `.env.example` files, and `docs/database-provisioning.md` before selecting a command. Confirm the required local configuration and database target; do not assume a start command creates an isolated database.
2. In Packscout, use `npm run dev:frontend`, `npm run dev:admin`, or `npm run dev:all` for the relevant surface. Inspect the existing utilities under `scripts/local` and documented provisioning commands if database setup is needed; provision only the intended local target within the user's authorization.
3. Check for port collisions and use the supported `PACKSCOUT_FRONTEND_PORT`, `PACKSCOUT_ADMIN_PORT`, and `PACKSCOUT_ADMIN_HMR_PORT` settings when needed. Record the chosen ports, process/session handles, and URLs; ports are not assigned automatically from branch names.
4. Wait for readiness, then drive the affected flows with the repository's runtime verification workflow and observe outcomes directly. Report any missing configuration or unavailable local runtime as a verification gap.

Use this local runtime check from the current phase worktree after phase integration before publishing a phase with a runnable surface. At the top of the stack, verify the cumulative feature state. Only skip it when the user explicitly opts out, the phase is deliberately dormant with an explicit later E2E owner, or the repository has no local runtime path.

### `teardown`

Stop only the service processes started for this verification run, using their recorded process/session handles. Use documented local cleanup commands only for resources owned by that run. Do not drop or reset databases without explicit authorization; starting the development services does not imply a disposable database was created.

## Parallel Delegation

When fanning out subagents, read [reference.md](reference.md) for parallel execution, context management, backpressure, worker selection, and phase ownership rules. The orchestrator alone owns phase boundaries, worktrees, branches, integration, publication, and restacking. Fan out task work within a phase; use separate phase worktrees for safe cross-phase or sibling work.

## Spec Compliance Gate

Related companion specs must be checked before a task is marked `done`.

For each task:

1. Identify related specs from feature `tech-*.md` and `ux-*.md` files whose `Related tasks` includes the task ID.
2. Confirm every relevant spec section is implemented, proven unnecessary, or explicitly diverged from.
3. Confirm every spec testing expectation is covered by verification or documented as not applicable.
4. Treat unresolved spec risks as blockers unless they are intentionally accepted and recorded.
5. Add or update a `## Spec Compliance` section in the task file before setting `**Status:** done`.

When one companion spec spans several delivery phases, evaluate only the sections relevant to the current task and its phase. Record the exact later task IDs that own remaining sections. Future sections do not block an earlier merge-safe phase, but an unowned section or an interface that is incomplete for the current phase does.

Use this note shape:

```markdown
## Spec Compliance

- Related specs reviewed: feature-name/tech-001, feature-name/ux-001
- Alignment: implemented as specified
- Divergences: none
- Later sections: none, or feature-name/004 owns [named section]
- Verification: npm test, focused manual check
```

If there are no related specs, write `Related specs reviewed: none`.

If implementation diverges from a companion spec, record the rationale:

```markdown
- Divergences: Used the existing service boundary instead of the proposed helper because repo standards already centralize this behavior in `packages/services`.
```

Do not edit `tech-*.md` or `ux-*.md` files during build unless the user explicitly asks. The task file records what actually happened.

## Framework Standards Guardrail

During implementation, check repository framework standards before marking tasks or dependency groups complete.

- Discover the fastest available command from repository scripts or guidance. Prefer ratchet-style commands such as `npm run scan:framework-standards:ratchet`; otherwise use the nearest focused standards command such as `npm run check:framework`, and save full verification commands such as `npm run verify:framework` for integration when they are too broad for every task.
- Run the guardrail after meaningful implementation slices that add or significantly expand source files, shared services, framework adapters, UI surfaces, generated artifacts, or task orchestration code.
- Treat new standards findings as implementation defects, not cleanup. Fix them before checking acceptance criteria, marking the task `done`, committing the dependency group, or handing the work to publish.
- When the finding points to module size, mixed responsibilities, boundaries, generated-code placement, or framework usage, prefer a focused split or local pattern alignment over suppressing the finding.
- If a subagent owns a task that could trigger standards findings, include the expected standards command in the subagent brief and require the subagent to report the result before handoff.
- If the repository has no framework standards command, note that it was not available and continue with the normal task verification set.

## Execution Rules

1. Read the task file first.
2. Read the feature `_index.md`.
3. Discover all feature `tech-*.md` and `ux-*.md` files and read the specs related to the task.
4. Read the repository instruction source.
5. Identify the task's owning delivery phase and direct PR base before editing. Read [stacked-prs.md](stacked-prs.md) for multi-phase work.
6. Explore the codebase and phase write scope before making changes.
7. Follow existing patterns unless the task explicitly requires a new one.
8. Respect the task interface contract and phase boundary. Do not implement later-phase behavior early or make an earlier phase depend on a later one.
9. Use related companion specs as implementation and UX guidance, but prefer the task file, current repo facts, and current product/design-system standards when they conflict.
10. Require each task's declared `## Verification` anchor to pass as the mechanical acceptance gate; fall back to the most relevant verification only for a legacy task with no runnable anchor.
11. Check off each acceptance criterion only after it is verified, then add or update `## Spec Compliance`.
12. Rerun the complete task verification set after fixes before marking the task `done`.
13. Run the framework standards guardrail during implementation and the repository's required final verifier at each publishable phase boundary.
14. Manage context aggressively: summarize and reset between dependency groups and delivery phases.
15. Keep task state, phase records, verification parent SHAs, and the live checklist synchronized with actual code and PR facts.
16. Commit meaningful dependency-group checkpoints, then publish at the phase boundary. Checkpoint commits are not a substitute for separate PRs.
17. Run `build` work from dedicated phase worktrees rather than the user's primary checkout.
18. Measure each phase against its direct base and split it before publication when the review-size gate requires it.
19. Treat phase deploy, commit, push, ready PR creation, stack maintenance, and stack review watch as part of the default completion path.
20. Only skip deploy or publishing when the user explicitly asks for a code-only stop point or the environment blocks those steps.
21. Never collapse completed phase branches into one final feature PR. Never combine planned phases without explicit user approval.

## Task Status Tracking

The `.tasks` files are the source of truth.

When a task is claimed, add or update:

```markdown
**Status:** in_progress
```

When a task is completed, make sure the task file includes:

```markdown
**Status:** done
```

near the top, and keep the feature `_index.md` task status column aligned with it. `done` means verified and committed on the owning phase head; it does not claim publication, approval, or merge.

When a task cannot proceed because of an unmet prerequisite or external blocker, use:

```markdown
**Status:** blocked
```

When work is abandoned or handed back unfinished, return it to:

```markdown
**Status:** todo
```

Status update rules:

1. Keep the task file and `_index.md` consistent.
2. If `_index.md` does not yet have a `Status` column, add one rather than tracking status in only one place.
3. Skip any task already marked `done` unless the user explicitly wants rework.
4. Do not mark a task `done` while its verified acceptance criteria remain unchecked in the task file.
5. Do not mark a task `done` until its `## Spec Compliance` note is present and accurate.
6. Never add or update task status in `tech-*.md` or `ux-*.md` files; they may use `**Spec status:**` only.
7. If you pause with unresolved work, leave an accurate status instead of optimistically marking completion.
8. If review feedback invalidates an acceptance criterion or verification result, return the affected task to `in_progress`, uncheck invalid evidence, fix it on the owning phase branch, and verify again.
9. If a phase PR is abandoned without a surviving branch that preserves the accepted implementation, return its tasks to `todo` in the surviving canonical plan.

Track delivery separately in `_index.md`:

1. Set a phase to `building` when its phase worktree begins implementation or re-verification.
2. Set it to `published` only after the ready PR exists, its base/head and phase-only diff are validated, and its branch/PR record is written.
3. Set it to `merged` only from live repository evidence.
4. Use `blocked` only for a genuine delivery prerequisite or external blocker. Ordinary review waiting remains `published`.
5. Record the workflow-owned branch, direct parent SHA used for the last verification, and PR URL in the phase details. Query GitHub for current review state instead of copying it into task status.

## Publish and PR Handoff

By default, a completed phase carries through to its own reviewable branch and pull request. Do not wait until every feature task is complete, and do not replace the stack with one cumulative PR.

For each phase:

1. Confirm every owned task is `done`, every related spec is accounted for, the phase merge gate and repository final verifier pass, and runtime/deploy evidence is recorded when applicable.
2. Compare the phase head to its direct base, separate authored from generated churn, and enforce the review-size gate.
3. Commit the verified phase and tracker evidence. Record the exact direct-parent SHA and verified implementation commit used for verification.
4. Push the workflow-owned phase branch, for example `codex/<feature>-pNN-<slug>`.
5. Open one ready-for-review PR against the declared direct base. Drafts are opt-in unless an unresolved blocker genuinely prevents review.
6. Validate the live PR head, base, and draft state. Require the observed direct-base head to be an ancestor of the phase head, then inspect the two-dot tree diff, child-only commit range, and PR diff. A clean three-dot diff alone does not prove current ancestry; a stale child or a child displaying ancestor work is not ready.
7. Update `_index.md` with the phase branch, PR URL, verified parent SHA, verified implementation commit, and `published` state; commit and push that delivery-only record. Rerun checks if repository verification includes task metadata.
8. Report the phase outcome, task IDs, verification, deploy result, authored/generated diff summary, commit SHA, direct base, and PR URL.
9. Start or refresh the stack review watch, then proceed to an eligible child or sibling under the backpressure rules.

Every PR body includes stack position, parent and child links when known, owned task IDs, direct base and verified parent SHA, phase-only scope, behavior deferred to later phases, verification and deploy evidence, diff summary, size exception if any, and merge order.

Merge phase PRs base-most first. A dependent child may be open for review while its parent is open, but must not merge into the unmerged parent branch. After a parent lands, restack and retarget the immediate child using [stacked-prs.md](stacked-prs.md), then re-verify its direct diff.

If deploy, push, PR creation, or stack validation cannot be completed, stop with a precise phase and descendant impact summary instead of silently treating the build as finished.

## PR Review Watch

After the first phase PR opens, watch the whole stack rather than treating one PR as the feature:

1. Spawn one background watcher whose only job is to monitor all open phase PRs, prioritizing the base-most phase. Preserve PR numbers, branch heads, stack relationships, and last-seen feedback identifiers for resume.
2. Poll about every two minutes for up to about 30 minutes:
   - 👍 reactions on each PR description: `gh api repos/{owner}/{repo}/issues/<number>/reactions --jq 'map(.content) | any(. == "+1")'`
   - new reviews and conversation comments: `gh pr view <number> --json reviews,comments`
   - new inline review comments: `gh api repos/{owner}/{repo}/pulls/<number>/comments`
   - live base/head, draft state, mergeability, state, and merge timestamp
3. Treat approval as phase-specific. A 👍 or approval marks only that PR reviewer-approved; continue watching the other open phases.
4. Route requested changes to the earliest phase branch that owns the affected invariant. Mark invalidated tasks `in_progress`, fix and verify them, push the owning phase, then restack and re-verify every affected descendant oldest-to-newest.
5. Reply to each inline review thread with the fix commit SHA and a one-line summary. For reviews, conversation comments, or CI failures, post one summary PR comment covering what changed and in which commits. Silent fixes are not complete.
6. When a parent merges, notify the orchestrator to restack and retarget its immediate child before later phases proceed. When a parent closes unmerged, mark descendants delivery-blocked and request direction; do not silently retarget them.
7. Stop watching a phase when it merges or is explicitly withdrawn. The stack is fully merged only when every intended phase is merged or explicitly withdrawn.
8. If the watch times out, report per-phase review state and the exact `resume` action. Do not summarize inactivity as stack approval.

The watcher is read-only and reports events. All fixes, tracker changes, restacks, pushes, and verification run through the owning phase worktrees and normal build gates.
