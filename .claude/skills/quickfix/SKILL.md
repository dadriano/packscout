---
name: quickfix
description: Diagnose and fix simple bugs or small tasks with a quick plan-then-execute workflow. Use for issues that don't warrant full task decomposition — generates a mini-PRD, gets confirmation, then implements the fix. Runs in an isolated worktree and opens a PR.
user-invocable: true
argument-hint: <description of the bug or task>
---

# Quickfix

Diagnose and fix a bug or small task in a single pass. This is the lightweight alternative to `/design-to-tasks` + `/build-from-tasks` — for issues that need a plan but don't need task files or worktrees.

**Input:** `$ARGUMENTS` contains the bug report or task description. If empty, ask the user to describe the issue.

## Workflow

### Phase 1: Investigate

1. **Parse the issue.** Extract the reported behavior, expected behavior, and any reproduction steps from the description.
2. **Explore the codebase.** Use Glob, Grep, and Read to find the relevant code paths. Understand the current behavior before proposing changes.
3. **Identify root cause.** Trace the issue to its source — don't just find where the symptom appears, find why it happens.

### Phase 2: Plan

**Work back and forth with the user, starting with your open questions and outline before writing the plan.** Present what you found during investigation, flag any ambiguities or trade-offs, and get alignment before committing to a plan. Only write the full plan after the user confirms your direction.

Output a structured mini-PRD:

```
## Quickfix Plan

**Issue:** [1-sentence summary of the bug/task]
**Root Cause:** [What's actually wrong and why]
**Affected Files:** [List of files that need changes]

### Changes
1. [First change — what and why]
2. [Second change — what and why]
...

### Acceptance Criteria
- [ ] [Observable behavior that proves the fix works]
- [ ] [Edge case or regression that must not break]
- [ ] [Any related behavior that should still work]

### Verification
[The verification anchor: a command that must exit 0, or the runtime verification scenario to drive and observe green. Use `none (no runtime surface)` only when the change has no runnable surface.]

### Risk
[Low/Medium — what could go wrong, what else touches this code]
```

**After outputting the plan, ask the user to confirm before proceeding.** Wait for explicit approval. If the user suggests adjustments, revise the plan and re-confirm.

### Phase 3: Execute (in isolated worktree)

Once the user confirms the plan:

1. **Create a worktree and branch.** Use the `EnterWorktree` tool to create an isolated worktree. Use branch name format: `fix/<short-slug>` (e.g., `fix/setup-logo-bypass`). This keeps your main workspace clean.
2. **Implement the changes** described in the confirmed plan inside the worktree.
3. **Follow existing patterns.** Match the codebase's style, naming, and architecture. Don't refactor surrounding code.
4. **Keep changes minimal.** Fix the issue and nothing else — no drive-by cleanups, no "while I'm here" improvements.

### Phase 4: Verify

1. **Run the plan's declared Verification anchor and require it to pass:** a command must exit 0, or the named runtime verification scenario must be driven and observed green. The acceptance criteria are not satisfied until the anchor passes. If the plan declares `none (no runtime surface)`, run the most relevant verification for the change and note what was run.
2. **Check each acceptance criterion.** For each one, provide concrete evidence it passes (command output, observed runtime behavior, or logical proof from the code).
3. **Run the build** if the project has a build step (`npm run build` or equivalent from CLAUDE.md). Run this inside the worktree.
4. **Run relevant tests** if they exist.
5. **Drive the affected flow end-to-end** with the repository's runtime verification workflow — a `/verify` skill, browser-driven flow, or scripted E2E check — when the environment exposes one. Observe the behavior directly instead of leaving end-to-end confirmation to manual testing.
6. **Run the framework standards guardrail** when the repository exposes one, preferring the fastest ratchet command (for example `npm run scan:framework-standards:ratchet`). Treat new findings as implementation defects to fix before committing.
7. **Rerun the full verification set once** after any fix made during verification, so earlier evidence is rechecked under the final combined state.

### Phase 5: Commit, PR, and Cleanup

1. **Commit the changes** in the worktree with a descriptive commit message summarizing the fix.
2. **Push the branch** to the remote.
3. **Open a PR** using `gh pr create` with:
   - A concise title (under 70 characters)
   - A body containing: Summary (bullet points of what changed and why), Acceptance Criteria (from the plan), and Test Plan
4. **Exit the worktree** using `ExitWorktree` to clean up.
5. **Report results:**

```
## Quickfix Complete

**Issue:** [summary]
**Branch:** [branch name]
**PR:** [PR URL]

**Changes Made:**
- [file:line — what changed]
- [file:line — what changed]

**Verification:**
- Anchor: [command or runtime scenario] — passed
- [x] [AC 1 — evidence]
- [x] [AC 2 — evidence]
- [ ] [AC 3 — no runtime surface: most relevant verification run instead, noted here]

**Build:** passing | [error details]
**Tests:** passing | [failure details] | n/a
**Standards guardrail:** clean | [findings fixed] | n/a
**Review watch:** started — polling the PR for review comments and a 👍 on the PR description
```

### Phase 6: PR Review Watch

Do not treat the run as finished when the PR opens — watch it for review feedback:

1. **Spawn a background watcher agent** (Agent tool with `run_in_background`) whose only job is to watch the PR.
2. **Poll on an interval** — about every 2 minutes, for up to about 30 minutes:
   - 👍 reaction on the initial PR comment (the PR description): `gh api repos/{owner}/{repo}/issues/<number>/reactions --jq 'map(.content) | any(. == "+1")'`
   - new reviews and conversation comments: `gh pr view <number> --json reviews,comments`
   - new inline review comments: `gh api repos/{owner}/{repo}/pulls/<number>/comments`
   - PR state: `gh pr view <number> --json state,mergedAt`
3. **Act on signals:**
   - A 👍 on the initial PR comment marks the PR as good: report the PR as reviewer-approved and stop the watch.
   - New review comments or requested changes: surface them immediately, address them on the same branch (re-enter a worktree on the branch if the original was already exited), rerun the Phase 4 verification set, push the fixes, and continue the watch.
   - PR merged or closed: stop the watch and report the final state.
4. **If the watch times out** with no signal, report that no review activity was observed yet and how to resume the watch.

## Rules

- **Always investigate first.** Don't guess at the fix from the description alone — read the code.
- **Always plan before executing.** Even if the fix seems obvious, write the plan and get confirmation. This catches misunderstandings early.
- **Always use a worktree.** Never modify files in the user's main workspace. All edits happen in the isolated worktree.
- **Minimal changes only.** The diff should contain exactly what's needed to fix the issue, nothing more.
- **Verify every AC with evidence.** Don't mark acceptance criteria as passing without proof, and treat them as unsatisfied until the plan's declared Verification anchor passes (a command exits 0, or the runtime verification scenario is driven and observed green). This is non-negotiable.
- **Always commit, push, and open a PR.** The deliverable is a ready-to-review PR, not just local changes.
- **Always exit the worktree** after pushing and opening the PR.
- **Always start the PR review watch** after opening the PR. A 👍 reaction on the initial PR comment marks the PR as good; new review comments must be surfaced and addressed before the fix is considered settled.
- **If the scope grows**, stop and tell the user. If investigation reveals the issue is larger than a quickfix (needs multiple coordinated changes across many files, architectural changes, or new features), recommend `/design-to-tasks` instead.
