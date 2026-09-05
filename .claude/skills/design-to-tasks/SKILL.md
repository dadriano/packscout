---
name: design-to-tasks
description: Decompose a project design doc into a .tasks/ folder of buildable task files. Use when starting a new project, breaking down a feature, or preparing work for parallel Claude Code worktree builds.
---

# Design to Tasks

Decompose a feature or project into a `.tasks/` folder of independently buildable task files, organized into subfolders.

**Argument hint:** `[path/to/design-doc.md]`

**Input:** If `$ARGUMENTS` contains a file path, read that design document as the source of truth. If no arguments are given (or arguments are not a file path), use the conversation context — the requirements, decisions, and scope already discussed — as the source of truth. Do NOT create an intermediary design document; go straight to task creation.

This skill creates product/task breakdowns, not companion specs. Companion files named `tech-*.md` and `ux-*.md` are reserved for `tasks-to-tech-specs` and `tasks-to-ux-specs`; ignore them for task numbering, dependency tracking, `_index.md` task tables, and parallel groups.

## Process

1. **Understand the full scope.** If a design doc was provided, read it thoroughly. Otherwise, synthesize everything from the conversation — every feature, behavior, edge case, constraint, and requirement discussed.

2. **Build a complete inventory.** Before writing any tasks, create a checklist of EVERY aspect. Extract:
   - Every feature or behavior described
   - Every user flow or interaction
   - Every data model, schema, or state
   - Every integration or external dependency
   - Every constraint, edge case, or error state
   - Every non-functional requirement (performance, security, accessibility, etc.)
   - Every UI element, page, or component described
   - Every configuration, setting, or admin capability

3. **Verify completeness.** Cross-check your inventory against the source (design doc or conversation). If something was discussed but not in your inventory, add it. **Nothing gets dropped.**

4. **Determine subfolder structure.** Each feature request or project gets **one subfolder** named after the feature (e.g., `image-transforms/`, `custom-domains/`, `org-management/`). Do NOT split a single feature into multiple subfolders by technical concern (e.g., don't create separate `billing/`, `ui/`, `backend/` folders for one feature). All tasks for a feature live together.

   Only create multiple subfolders when the user explicitly requests multiple unrelated features at once — each feature gets its own subfolder.

5. **Group into tasks within the subfolder.** Organize inventory items into coherent, independently buildable tasks. Each task should describe a meaningful outcome, not a technical layer. A task like "user can search files by name" is better than "create search API endpoint."

6. **Create `.tasks/` directory structure:**
   ```
   .tasks/
   ├── feature-name/
   │   ├── _index.md          # Feature index with context and build order
   │   ├── 001-task-name.md
   │   ├── 002-task-name.md
   │   ├── tech-001-contract.md  # Optional companion spec from tasks-to-tech-specs
   │   ├── ux-001-flow.md        # Optional companion spec from tasks-to-ux-specs
   │   └── ...
   ```

7. **Write one markdown file per task** using the format below.

8. **Write the feature `_index.md`** with feature context, task list, and dependency/build order.

9. **Preserve companion spec files.** If the feature folder already contains `tech-*.md` or `ux-*.md` files, leave them in place unless the user explicitly asks to regenerate or remove companion specs. Do not include them in the `_index.md` task table.

10. **Handoff for companion planning.** When task decomposition is complete and the user wants implementation details, suggest running `tasks-to-tech-specs` on the feature folder. When the user wants UX design details, suggest running `tasks-to-ux-specs`.

## Task File Format

Every file follows this structure. Name files `NNN-short-name.md` where the number indicates dependency order within the area.

Task IDs are scoped to their feature subfolder: `feature-name/NNN`. For example, `image-transforms/001`, `custom-domains/003`.

```markdown
# Task: [Short Title]

**ID:** area-name/NNN
**Depends on:** [task IDs (area/NNN format) or "none"]
**Blocks:** [task IDs this must complete before]
**Estimated scope:** [small | medium | large]

## Objective

[1-2 sentences. What outcome does this task produce? Describe the result from the user's or system's perspective, not the technical implementation.]

## Context

[Background the builder needs to understand WHY this task exists. What problem does it solve? How does it fit into the larger system? Reference relevant parts of the design doc.]

## Requirements

- [What must be true when this task is done — described as behaviors, capabilities, or outcomes]
- [NOT how to implement it — let the builder decide the technical approach]
- [Include edge cases, error states, and constraints]

## User-Facing Behavior

[If applicable: what does the user see, click, or experience? Describe the interaction, not the component tree.]

## Interface Contract

[What other tasks expect from this one. Describe the boundaries — what data flows in, what data flows out, what other tasks will depend on. Be specific about shapes and names so tasks can integrate, but don't dictate internal implementation.]

## Acceptance Criteria

- [ ] [Observable behavior that proves this task is done]
- [ ] [Edge case or error state that must be handled]
- [ ] [Integration point that must work with dependent tasks]

## Verification

[Required. One machine-checkable anchor that proves the acceptance criteria hold: a command expected to exit 0 (a targeted test, typecheck, or build) or a named `/verify` scenario that drives the affected flow and observes the outcome. Describe the check's intent and pass condition, not file paths or exact commands — the builder discovers those from the repo. This is what turns "done" from a judgment call into a mechanical gate. If the task genuinely has no runtime surface (pure docs or static config), write "none (no runtime surface)" and say why.]
```

## Feature Index Format

Each feature subfolder has an `_index.md`:

```markdown
# Feature: [Feature Name]

## Context

[What this feature is and why it matters. Enough background for a builder to understand the feature without reading the full design doc or conversation.]

## Tasks

| ID | Task | Scope | Depends on |
|---|---|---|---|
| 001 | [Short title] | small | none |
| 002 | [Short title] | medium | 001 |

## Build Order

[Dependency chain and which tasks can run in parallel]

## Parallel Groups

- Group A (no deps): [task IDs]
- Group B (after A): [task IDs]
```

If the feature is large, you may organize tasks into sub-subfolders within the feature folder for clarity (e.g., `.tasks/image-transforms/ui/`, `.tasks/image-transforms/backend/`). The `_index.md` at the feature root still covers all tasks regardless of nesting.

## Companion Spec Files

`tech-*.md` files are optional implementation guidance produced by `tasks-to-tech-specs`. `ux-*.md` files are optional UX design guidance produced by `tasks-to-ux-specs`. They are not task files.

When creating, updating, or reviewing a task breakdown:

- Ignore `tech-*.md` and `ux-*.md` files when choosing the next task number.
- Do not list `tech-*.md` or `ux-*.md` files in `_index.md` task tables, build order, or parallel groups.
- Do not use `tech-*.md` or `ux-*.md` files as `Depends on` or `Blocks` task IDs.
- Preserve existing companion spec files unless the user explicitly asks to regenerate, replace, or remove them.
- Keep task files implementation-agnostic even when companion specs exist.

## Rules

### Completeness is non-negotiable
- **Every item from the source (design doc or conversation) must appear in a task.** If something was discussed or specified, it's a task or part of a task. Period.
- Complex, ambiguous, or cross-cutting concerns are often the MOST important tasks — don't skip them because they're hard to categorize.
- When in doubt, create the task. It's easier to merge two tasks later than to discover a gap during build.

### Describe goals, not implementation
- Tasks describe **what** needs to be true, not **how** to build it.
- Do NOT specify file paths, frameworks, libraries, or code patterns — the builder will read the project's CLAUDE.md and codebase to determine the right approach.
- Do NOT include "Files to Create/Modify" or "Do NOT Touch" sections — these over-constrain the builder and become stale.
- Requirements should be testable behaviors: "users can search files by name" not "add a search input that calls GET /api/files?q=".
- The `## Verification` field is the one place that names a concrete pass condition — a runnable check (test, typecheck, build, or a `/verify` scenario) that mechanically proves at least one acceptance criterion. Still describe the check's outcome, not file paths or exact commands; the builder discovers those from the repo. This is the anchor `build-from-tasks` gates `done` on, so every task with a runtime surface must carry one.

### Tasks must be self-contained
- Each task must be independently buildable by a fresh Claude session that has never read the design doc.
- Include ALL context needed in the task file — the Objective, Context, and Requirements sections should give the builder everything they need.
- The builder should be able to execute any task by reading only that task file and the project's CLAUDE.md.

### Subfolders are mandatory
- **NEVER place task files directly in `.tasks/`.** Every task MUST live inside a feature subfolder (e.g., `.tasks/image-transforms/001-pricing-toggle.md`, NOT `.tasks/001-pricing-toggle.md`).
- One feature request = one subfolder. All tasks for that feature go in the same subfolder.
- Sub-subfolders within a feature are fine for organization (e.g., `.tasks/image-transforms/ui/`, `.tasks/image-transforms/backend/`).
- The only things allowed directly in `.tasks/` are feature subfolders (and legacy flat files from before this convention). `tech-*.md` and `ux-*.md` files, when present, belong inside the relevant feature folder beside the source tasks.

### Structural rules
- Number tasks in **dependency order**
- Keep tasks **focused** — one coherent outcome per task
- Prefer **more small tasks** over fewer large ones — easier to parallelize and verify
- Define **interface contracts** between tasks so they can integrate cleanly
- If two tasks would produce conflicting changes, they need clearer boundaries or should be merged

## Output shape for the human reader

This skill produces two kinds of writing with two different readers, and only one of them takes the shape below.

**Task file bodies are written for a builder** — a fresh Claude session with no context. They stay complete. Never compress `Context`, `Requirements`, `Interface Contract`, or `Acceptance Criteria` to make them faster to read; a truncated spec produces a wrong build. The rules in "Tasks must be self-contained" win over brevity every time.

**Everything you say to the user is written for a reader with ADHD.** Working memory is small, starting is the hardest step, and a buried next action does not get taken. So:

### The `## Build Order` section of `_index.md`

A human reads this to decide what to start. Write it as a numbered list, one bounded action per step, naming which task IDs run in parallel. Not a prose paragraph describing the dependency graph — the reader has to be able to act on step 1 without holding the whole graph in their head.

### Your handoff message

1. **First line names what now exists and where** — the folder path and the task count. No preamble, no "I explored X and found Y."
2. **Then the task table or a grouped list.** This is the answer, so it is not capped; group it by track if it runs long.
3. **Then at most 3 flagged risks or decisions, ranked by what would hurt most if missed.** Not every observation you made while exploring. A fourth flag belongs in a task file, not the message.
4. **Last line is one concrete next action** the user can take in under two minutes — the command to start the first task, or the specific decision you need from them.

Cut before sending: any sentence announcing what you are about to do, any recap of your own process, any "by the way" sidebar, and any closing pleasantry. Verify that a reader who reads only the first and last line knows what exists and what to do next.

### Estimates

When you state effort, use concrete units the reader can plan against — "two or three sessions", "an afternoon", "a day if the schema is already right". Never "some work" or "a bit involved". Scope labels on task files (`small`/`medium`/`large`) are for the builder and are not a substitute for telling the human how long the feature takes.

### Keep it simple (eli5)

Before writing the handoff message, load the `eli5` skill (Skill tool) with the audience pinned to "a busy technical reader who skims" — purpose before mechanism, one idea per sentence, concrete over abstract, no unexplained jargon. Its "simplify ruthlessly at 80% accuracy" license applies only to prose the user reads; task files and `_index.md` stay complete and precise. If `eli5` is not installed or not invocable, apply those four principles directly rather than skipping the step.

### Interaction with `/i-have-adhd`

The rules above are this skill's own defaults and apply whether or not that skill is running. If the user has invoked `/i-have-adhd`, its rules govern the entire session and outrank these; nothing in this skill turns it on, off, or invokes it — it is user-invocable only.
