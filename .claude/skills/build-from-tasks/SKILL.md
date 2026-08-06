---
name: build-from-tasks
description: Execute buildable tasks from a .tasks/ folder using dependency planning, canonical .tasks status updates, isolated worktrees, parallel subagents via the Agent tool when appropriate, and full publish handoff through commit, push, and PR creation. Use when a project has already been decomposed into task files and implementation is ready to begin. Trigger with /build-from-tasks.
---

# Build from Tasks

Read the `.tasks/` folder and execute task files while respecting dependency order, task boundaries, repository conventions, and the canonical `.tasks` tracker.

Preserve this operating model:

- read the task plan first
- respect dependency groups
- isolate work when possible
- track task status directly in the canonical `.tasks` files
- integrate and verify after each major group
- treat deploy, commit, push, PR creation, and the post-PR review watch as part of completion, not optional cleanup

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

Exclude `tech-*.md`, `ux-*.md`, and files under `.tasks/<feature>/mockups/` from canonical task state. Do not parse them as runnable tasks, do not add them to `_index.md`, and do not update task status in them.

If helper scripts exist, they may be convenient for local execution, but they are not required and must not be treated as the workflow's source of truth.

## Companion Specs

When a feature folder contains `tech-*.md`, `ux-*.md`, or `.tasks/<feature>/mockups/` files, treat them as companion guidance that must be reviewed before building related tasks.

Companion spec rules:

- Discover all `tech-*.md` and `ux-*.md` files in the feature folder before `plan`, `build`, `next`, explicit task, and `integrate` modes.
- Discover `.tasks/<feature>/mockups/` artifacts during the same modes when they exist, especially for UI tasks that reference related UX specs.
- Match specs to tasks through the `**Related tasks:** feature/001, feature/003` line.
- Read specs related to a task before implementation or subagent handoff.
- Read all feature-level companion specs during planning and integration. Use tech specs for shared write scopes, sequencing risks, contracts, database changes, endpoints, and verification expectations. Use UX specs and mockups for user flows, information architecture, layout, states, accessibility, content, visual direction, and review expectations.
- Exclude `tech-*.md`, `ux-*.md`, and `.tasks/<feature>/mockups/` files from runnable task discovery, dependency parsing, task numbering, task status updates, `_index.md` status sync, and acceptance-criteria checkbox updates.
- Treat task files, current repository facts, and current product/design-system standards as authoritative when they conflict with a companion spec.
- Record any intentional divergence from a related companion spec before marking a task `done`.

If a companion spec references Convex implementation details or Convex-driven UX behavior and the repository contains `convex/_generated/ai/guidelines.md`, read that guideline file before changing Convex code.

## Execution Checklist (TodoWrite)

Mirror active build progress in the TodoWrite checklist. The `.tasks` files remain the canonical source of truth. The checklist is a live execution view for the user, not a replacement tracker.

Checklist rules:

- After reading the feature `_index.md`, the relevant task files, and the repo instructions, create or update todos so progress appears early in the run.
- Default to showing the current execution phases or dependency groups, not every tiny implementation detail.
- Keep exactly one checklist item `in_progress` at a time.
- When a task or dependency group finishes, update the checklist promptly so completed work is marked `completed` and the next active item becomes `in_progress`.
- If work is paused on an external dependency or unresolved failure, reflect that in the explanation and keep the next actionable item pending until the blocker is cleared.
- Keep the checklist synchronized with the real `.tasks` status. If they diverge, fix the `.tasks` files first and then refresh the checklist.
- In short runs for a single task, a compact checklist is fine, for example: inspect, implement, verify, update tracker.

## Supported Modes

### `plan`

Show the full build plan without editing code:

1. Read the feature `_index.md`.
2. Read each task file in scope.
3. Discover all feature `tech-*.md` and `ux-*.md` files and map them to related task IDs.
4. Read the repository instruction source, usually `AGENTS.md`, `CLAUDE.md`, or equivalent.
5. List all tasks with current status, dependencies, task grouping, and related companion specs.
6. Identify which tasks can run in parallel and which must stay sequential, using companion specs to flag shared write scopes, UX dependencies, and sequencing risks.
7. Recommend the execution strategy:
   - single-session sequential build
   - subagent delegation by dependency group via the Agent tool
   - manual multi-worktree rollout if the user wants separate sessions
8. Show integration checkpoints, deploy checkpoints, spec-compliance checkpoints, and suggested commit boundaries.
9. Show the required worktree setup for the build flow.
10. Show the publish path for the final branch and PR.
11. Create todos with the proposed execution phases so the checklist is visible during planning too.

Preferred output shape:

```markdown
## Build Plan

### Option A: Manual Worktrees

Parallel Group A (launch now):
  git worktree add .worktrees/admin-ux-001 -b cursor/admin-ux-001 HEAD  -> admin-ux-nesting/001 [implementation]
  git worktree add .worktrees/admin-ux-011 -b cursor/admin-ux-011 HEAD  -> admin-ux-nesting/011 [ux]

Parallel Group B (after Group A):
  ...

Integration:
  main session -> review, merge, run typecheck/tests

Deploy:
  ./scripts/deploy-local.sh

Publish:
  git push -u origin cursor/admin-ux-nesting
  gh pr create ...

### Option B: Parallel Subagents (Agent tool)
  Group A: main session + subagent ownership map
  Group B: ...
```

Include a recommended subagent brief for each task or worktree based on the Worker Selection table below.

### `build`

This is the primary execution mode.

Always start `build` in a dedicated git worktree so the user's main workspace stays untouched while the feature is under construction.

1. Read the feature `_index.md` to understand dependency order, parallel groups, and build order.
2. Read the repository instruction source such as `AGENTS.md`, `CLAUDE.md`, or other project guidance.
3. Discover all `tech-*.md` and `ux-*.md` files in the feature folder and map each one to its `Related tasks`.
4. Inspect current git state before editing.
5. Create or enter a dedicated worktree for the feature:
   - Preferred worktree path: `.worktrees/<feature-folder-name>`
   - Preferred branch name inside that worktree: `cursor/<feature-folder-name>`
   - Example:

```bash
git worktree add .worktrees/admin-ux-nesting -b cursor/admin-ux-nesting HEAD
```

6. Perform all build work from inside that worktree.
7. When parallel work is in scope, proactively use the Agent tool with disjoint ownership from that worktree-backed build flow for dependency-free groups.
8. Build the dependency graph from `_index.md` and task statuses, excluding `tech-*.md` and `ux-*.md` files. Skip tasks already marked `done`.
9. Create or update todos with the current execution phases or dependency groups before starting implementation, and keep them updated throughout the run.
10. Before starting a task, mark it `in_progress` in the canonical tracker.
11. Execute dependency groups in order:
   - For any dependency group with multiple runnable tasks, proactively run them in parallel when their write scopes are clearly compatible.
   - Otherwise execute them sequentially in the main session.
   - Before implementing or handing off a task, read every related companion spec and include the relevant guidance in the local plan or subagent brief.
12. After each dependency group:
   - review landed changes
   - run `git status` and `git diff --stat`
   - resolve overlaps or integration issues
   - run each task's declared `## Verification` anchor and require it to pass: a command must exit 0, or the named runtime verification scenario must be driven and observed green. A task's acceptance criteria are not satisfied until its Verification anchor passes. If a task file predates the Verification field or declares `none (no runtime surface)`, fall back to the most relevant verification for the change and note what was run
   - run any additional group-level verification relevant to the landed changes
   - run the framework standards guardrail during implementation when the repository exposes one, preferring the fastest ratchet command such as `npm run scan:framework-standards:ratchet`
   - confirm that each task's acceptance criteria is actually satisfied, not just partially implemented
   - verify related companion spec compliance for each task, including documented divergences
   - check off each verified acceptance-criteria checkbox in the task file as the criteria are confirmed
   - if a subagent handoff does not satisfy the acceptance criteria, reassign the task to another subagent or continue locally until it does
   - when retrying with another subagent, hand off the current workspace state, the files already changed, the criteria already satisfied, and the exact remaining gap so the retry starts from existing progress rather than redoing the task
   - once all acceptance criteria for the task or dependency group appear satisfied, rerun the full acceptance-criteria verification set to make sure later fixes did not break earlier ones
   - add or update the task file's `## Spec Compliance` note before marking the task `done`
   - mark completed tasks `done`
   - mark failed or interrupted tasks back to `todo` or `blocked` with a note
   - refresh todos so the checklist reflects the newly completed and newly active work
   - commit the completed checkpoint when appropriate
13. After all groups are complete, run the full integration pass, including feature-level spec-compliance review across all completed tasks.
14. After the full integration pass, run the deploy mode for end-to-end verification unless the user explicitly asked to skip deploy or the repository has no local deploy path.
15. After deploy succeeds, stage and commit the final integrated work if it is not already committed.
16. Push the worktree branch and open a ready-for-review PR unless the user explicitly asked not to publish yet.
   - Draft PRs are opt-in only.
   - Only open a draft PR when the user explicitly asks for a draft or when an unresolved blocker makes the branch not actually reviewable.
   - If a publish helper or connector defaults to draft PRs, override that default for this workflow.
17. Report the deploy result, commit SHA, branch name, and PR URL back to the user.
18. Start the PR review watch described under Publish and PR Handoff.

### `feature-name/NNN` or explicit task IDs

Execute specific tasks directly in the current session:

1. Read each referenced task file.
2. Read the feature `_index.md`.
3. Discover and read each `tech-*.md` and `ux-*.md` file whose `Related tasks` includes the task ID.
4. Read the repo instruction file.
5. Explore the relevant code before editing.
6. Mark the task `in_progress`.
7. Implement the task while following the interface contract, acceptance criteria, and related companion specs.
8. Run the task's declared `## Verification` anchor and require it to pass (a command must exit 0, or the named runtime verification scenario must be driven and observed green), then run the framework standards guardrail when the repository exposes one. If the task declares no anchor or declares `none (no runtime surface)`, run the most relevant verification and note what was run.
9. Add or update the task file's `## Spec Compliance` note.
10. Mark the task `done` and report what was completed.

### `next`

Find the next unfinished task or tasks with no unmet dependencies.

1. Read the feature `_index.md`.
2. Read task files that are not already `done`, excluding `tech-*.md` and `ux-*.md` files.
3. Discover companion specs and use related specs only to understand implementation guidance, UX guidance, and write-scope conflicts.
4. Treat a task as runnable only if:
   - it is not `done`
   - it is not already `in_progress` unless the user is explicitly resuming it
   - every dependency listed in `Depends on` is `done`
5. If several tasks are independently runnable:
   - recommend a parallel group in `plan`
   - in `build`, proactively delegate them in parallel when parallel subagent work is in scope and the write scopes are low-conflict
6. If only one task is runnable, execute it directly or recommend it as the next step.

### `integrate`

Run a post-build integration pass:

1. Review the completed tasks and feature index.
2. Review all feature `tech-*.md` and `ux-*.md` files and confirm completed tasks have spec-compliance notes covering related specs or documented divergences.
3. Run the app, build, typecheck, lint, or tests to surface integration issues.
   - Re-run the completed tasks' `## Verification` anchors as a combined regression pass so anchors that passed in isolation still pass together.
   - Drive the completed feature end-to-end with the repository's runtime verification workflow, such as a `/verify` skill, browser-driven flow, or scripted E2E check, when the environment exposes one. Observe the behavior directly instead of leaving end-to-end confirmation to manual testing.
   - Include the framework standards guardrail when the repository exposes one, especially before committing or publishing.
4. Fix cross-task wiring issues, broken imports, contract mismatches, spec mismatches, and regressions.
5. Re-verify the feature as a whole.
6. Update any task status or spec-compliance note that changed during the integration pass.

### `deploy`

Deploy the current build locally for end-to-end verification on isolated ports:

```bash
./scripts/deploy-local.sh
```

This script creates an isolated database, assigns deterministic ports from the branch name, starts the local services, and reports the URLs when ready.

Override the base port when needed:

```bash
DEPLOY_BASE_PORT=4500 ./scripts/deploy-local.sh
```

Use deploy after the integration pass as the default final verification step before publishing. Only skip it when the user explicitly opts out or the repository does not support a local deploy path.

Once the deploy is up, drive the affected flows against it with the repository's runtime verification workflow when available, and observe the outcomes directly. Fall back to manual testing only when no runtime verification path exists.

### `teardown`

Decommission a local deploy:

```bash
./scripts/deploy-local.sh teardown
```

This stops services, drops the deploy database, and cleans up temporary deploy files.

## Parallel Delegation

When fanning out subagents with the Agent tool, read [reference.md](reference.md) for parallel execution, context management, backpressure, and worker selection rules.

## Spec Compliance Gate

Related companion specs must be checked before a task is marked `done`.

For each task:

1. Identify related specs from feature `tech-*.md` and `ux-*.md` files whose `Related tasks` includes the task ID.
2. Confirm every relevant spec section is implemented, proven unnecessary, or explicitly diverged from.
3. Confirm every spec testing expectation is covered by verification or documented as not applicable.
4. Treat unresolved spec risks as blockers unless they are intentionally accepted and recorded.
5. Add or update a `## Spec Compliance` section in the task file before setting `**Status:** done`.

Use this note shape:

```markdown
## Spec Compliance

- Related specs reviewed: feature-name/tech-001, feature-name/ux-001
- Alignment: implemented as specified
- Divergences: none
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
5. Explore the codebase before making changes.
6. Follow existing patterns unless the task explicitly requires a new one.
7. Respect the interface contract defined by the task.
8. Use related companion specs as implementation and UX guidance, but prefer the task file, current repo facts, and current product/design-system standards when they conflict.
9. Check acceptance criteria before marking work complete, and require each task's declared `## Verification` anchor to pass (a command must exit 0, or the named runtime verification scenario must be driven and observed green) as the mechanical gate. Treat acceptance criteria as unsatisfied until the anchor passes; fall back to the most relevant verification when a task declares no anchor or declares `none (no runtime surface)`.
10. Check off each acceptance-criteria checkbox in the task file only after that criterion has been verified.
11. Verify the spec-compliance gate and add or update the task's `## Spec Compliance` note before marking work complete.
12. After all criteria and spec-compliance checks are satisfied, rerun the full set once more as a regression pass before marking work complete.
13. Run the framework standards guardrail during implementation when the repository exposes one, and treat new findings as blockers before marking tasks or dependency groups complete.
14. Manage context aggressively: summarize, narrow scope, and reset between dependency groups instead of carrying unnecessary history forward.
15. Keep the canonical task tracker in sync with real progress, including acceptance-criteria checkboxes.
16. Keep the TodoWrite checklist in sync with the current execution phase.
17. Prefer committing after each meaningful dependency group instead of one giant final diff.
18. Run `build` work from a dedicated worktree rather than the user's primary checkout.
19. Treat deploy, final commit, push, PR creation, and the post-PR review watch as part of the default completion path.
20. Only skip deploy or publishing when the user explicitly asks for a code-only stop point or the environment blocks those steps.
21. Treat "open a PR" as "open a ready-for-review PR" by default. Do not silently open a draft PR unless the user explicitly requested one.

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

near the top, and keep the feature `_index.md` status column aligned with it.

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

## Publish and PR Handoff

By default, a completed `build` should carry through to a reviewable branch and pull request. Do not stop at "implementation finished" unless the user explicitly asks to pause before publish or an environment limitation prevents the next step.

PR readiness default:

- Open a ready-for-review PR by default.
- Do not open a draft PR unless the user explicitly asks for a draft or there is a clearly stated blocker that prevents review.
- If a reusable publish skill, GitHub connector, or CLI wrapper defaults to draft PRs, explicitly override that behavior here.
- If a tool unexpectedly creates a draft PR anyway, convert it to ready-for-review before reporting the build as complete.

1. Make sure the worktree branch contains the completed dependency groups and integration fixes.
2. Run each completed task's declared `## Verification` anchor plus the local deploy flow when the repository supports it, and drive the feature end-to-end with the repository's runtime verification workflow when available.
3. Stage and create a final commit if the latest integrated state is not yet committed.
4. Push the branch:

```bash
git push -u origin cursor/<feature-folder-name>
```

5. Open a ready-for-review pull request targeting the expected base branch, usually `main`:

```bash
gh pr create
```

6. In the PR body, summarize:
   - what feature or task set was built
   - which task IDs were completed
   - what verification was run
   - whether local deploy was exercised

7. Report the deploy result, commit SHA, pushed branch, and PR URL back to the user.

8. Start the PR review watch below.

If deploy, push, or PR creation cannot be completed, stop with a precise blocker summary rather than silently treating the build as fully finished.

## PR Review Watch

After a PR is opened and reported, do not treat the build as finished — watch the PR for review feedback:

1. Spawn a background watcher agent (Agent tool with `run_in_background`) whose only job is to poll the PR.
2. Poll about every 2 minutes, for up to about 30 minutes:
   - 👍 reaction on the initial PR comment (the PR description): `gh api repos/{owner}/{repo}/issues/<number>/reactions --jq 'map(.content) | any(. == "+1")'`
   - new reviews and conversation comments: `gh pr view <number> --json reviews,comments`
   - new inline review comments: `gh api repos/{owner}/{repo}/pulls/<number>/comments`
   - PR state: `gh pr view <number> --json state,mergedAt`
3. Act on signals:
   - A 👍 on the initial PR comment marks the PR as good: report the PR as reviewer-approved and stop the watch.
   - New review comments or requested changes: surface them immediately, address them on the feature branch from the feature worktree, push the fixes, and continue the watch.
   - PR merged or closed: stop the watch and report the final state.
4. If the watch times out with no signal, report that no review activity was observed yet and how to resume the watch.
5. The watcher only reads PR state and reports. Fixes land through the normal build flow in the feature worktree, gated by the same task verification anchors as the original work.
