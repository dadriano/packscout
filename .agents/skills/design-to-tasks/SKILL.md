---
name: design-to-tasks
description: Resolve material product-design decisions through iterative planning questions, then decompose the approved design into an ADHD-friendly feature PRD, actionable task PRDs, and reviewable delivery phases in a .tasks/ folder. Use when starting a new project, breaking down a feature, preparing phased or parallel builds, or when the user runs /design-to-tasks. Planning only — do not implement unless the user explicitly asks to execute tasks.
---

# Design to Tasks

Decompose a feature or project into a `.tasks/` folder of independently buildable task files and independently reviewable delivery phases, organized into subfolders.

**Input:** If the user provides a file path, read that design document as the source of truth. If no path is given, use the conversation context — the requirements, decisions, and scope already discussed — as the starting source. Inspect the repository for discoverable current-state facts when they materially affect the design.

Do NOT create an intermediary design document. Resolve decisions in conversation, confirm alignment, then write the decisions directly into the feature index and self-contained task files.

Treat `_index.md` as the feature PRD and every numbered task file as an actionable mini-PRD.

Keep these planning units distinct:

- A **task** is an independently buildable outcome.
- A **parallel group** identifies tasks that can be implemented concurrently.
- A **delivery phase** is the maximum scope of one reviewable pull request.

Parallel groups and delivery phases may overlap, but neither implies the other. Two adapters may be built concurrently yet published as sibling phase PRs; several tightly coupled tasks may belong to one phase while being implemented sequentially.

This skill creates product/task breakdowns, not companion specs or mockups. Companion files named `tech-*.md` and `ux-*.md`, plus files under `.tasks/<feature>/mockups/`, are reserved for `tasks-to-tech-specs` and `tasks-to-ux-specs`; ignore them for task numbering, dependency tracking, `_index.md` task tables, and parallel groups.

**Do not implement, edit production code, delete files, change schema, or run cleanup** unless the user explicitly asks to execute the tasks. Suggest `/tasks-to-tech-specs`, `/tasks-to-ux-specs`, and `/build-from-tasks` as follow-ups.

## ADHD-Friendly Planning and PRDs

Before asking planning questions or writing PRD artifacts, read [i-have-adhd](../i-have-adhd/SKILL.md) completely and apply it for the rest of the design-to-tasks session.

Apply its rules to both the conversation and the generated `_index.md` and numbered task files:

- Lead each question batch with the single decision the user needs to make next. Ask no more than three related questions.
- Start every PRD with a `Start Here` section that gives one bounded, implementation-agnostic next action.
- Number ordered work, use concrete time ranges, and make completion visible with status and acceptance checkboxes.
- Cap a visible list at five items. Split longer inventories into labeled groups without dropping or deprioritizing requirements.
- Remove preambles, tangents, vague estimates, and closing pleasantries. End the feature PRD with one concrete next action.

ADHD shaping changes presentation, not rigor. Preserve the decision-resolution gate, complete inventory, self-contained context, interface contracts, and every required behavior. If an ADHD rule conflicts with those requirements, keep the requirement and adapt its presentation.

## Delivery Phases and Pull Requests

Create an explicit delivery plan for every feature before writing the final task set.

- Assign every numbered task to exactly one phase identified as `P01`, `P02`, and so on.
- Map one phase to one pull request by default.
- Stack a phase on an earlier phase when it needs that phase's unmerged code. Use sibling PRs when phases share a prerequisite but can merge in either order. Use the repository default branch for truly independent phases.
- Require every phase to be complete, verified, and safe to merge against its declared PR base. A dormant or internal foundation is acceptable; a broken or unsafe partial product is not.
- Treat a planned phase as maximum scope. A builder may split it further when the actual diff is too large, but must not combine planned phases without explicit user approval.

Tasks remain outcome-oriented. A phase may align with an architectural or reviewer seam such as an Admin surface, scheduled worker, shared adapter contract, or individual provider adapter only when that seam produces a coherent, independently verifiable result. "Add backend files" is not a reviewable outcome; "scheduled promotions execute idempotently and expose failure evidence" is.

Do not introduce a feature flag, compatibility shim, dual read, dual write, or provider-specific branch merely to manufacture a phase boundary. If an interim compatibility mechanism is required, treat it as a material decision and record its owner, removal phase, and removal condition.

### Review-size gate

Target a phase at one reviewer thesis, no more than three coherent tasks, no more than two primary runtime surfaces, and about one to two implementation days including focused verification.

An expected authored diff above roughly 2,500 changed lines or 25 authored files is a mandatory split review, not an automatic waiver. Split the phase again when a stable merge-safe boundary exists. When it does not, record a `Size exception` in the phase details explaining why a smaller PR would be less safe or less reviewable, and include that exception in the alignment checkpoint.

Tests and migrations count as authored changes. Report lockfiles, vendored content, and objectively generated output separately so generated volume cannot hide an oversized authored change. Keep required generated output with the source change that produces it.

Use one phase and one PR only when the whole feature is small, cohesive, safe to merge atomically, and within the review target. A feature spanning independently reviewable surfaces, workers, migrations, permissions, or provider adapters should normally use multiple phases.

### Phase-quality gate

Before writing files, verify all of these invariants:

- Every task belongs to exactly one phase, and a task depends only on tasks in its own or an earlier phase.
- Each phase has one review promise, one declared PR relationship, and a merge gate that can pass without later phases.
- Cross-phase interfaces are complete and tested in the earlier phase before a later phase consumes them.
- The post-merge state preserves build health, permissions, data integrity, and existing behavior, including when new capability remains dormant.
- The final phase contains activation, wiring, or certification work only when that work is genuinely new; it is not a catch-all that recombines implementation from earlier phases.

If a phase fails this gate, split or regroup tasks before producing the task files. Phase IDs never appear in task `Depends on` or `Blocks`; those fields contain task IDs only.

## Decision-Resolution Gate

**Never create or update task files while a material product decision is unresolved.** A task requirement such as "decide whether," "confirm whether," "TBD," "if desired," "as applicable," or two mutually exclusive outcomes is evidence that clarification stopped too early.

Before decomposition, classify every gap:

- **Discoverable fact:** inspect the design source, repository, current UX, documentation, schemas, or tests. Do not ask the user to answer something the project can answer.
- **Product decision:** ask the user. This includes user-visible behavior, scope, terminology, ownership, permissions, lifecycle, safety policy, compatibility, and which outcome should exist.
- **Implementation decision:** leave it to the builder unless it changes product scope, an interface contract, task boundaries, dependencies, or risk.
- **Research uncertainty:** create a bounded research/spike task only when the answer cannot reasonably be discovered or decided now and the user agrees that research is the intended outcome. A spike is not a substitute for a product decision.

A decision is material when different answers would change any of these:

- the user promise or success criteria
- actors, ownership, permissions, or safety
- in-scope behavior or explicit non-goals
- a core flow, state, lifecycle, or error outcome
- data ownership, retention, migration, or compatibility
- an integration or external dependency
- public interfaces between tasks
- task boundaries, dependency order, or estimated scope

Delivery-specific product decisions are material when they determine what may safely exist after an intermediate merge, which phase activates user-visible behavior, whether a migration or cutover needs temporary compatibility, whether integrations can roll out independently, or where rollback authority changes. Resolve those decisions before fixing the phase topology. Branch names and ordinary stack mechanics remain implementation decisions.

### Ask planning-style questions

- Ask all material questions needed for a build-ready design, but ask them iteratively rather than dumping a questionnaire.
- Ask 1-3 related questions per batch, highest-impact decisions first. Wait for the user's response before continuing.
- When a structured planning-question tool is available, use it. Otherwise ask concise plain-text questions.
- Prefer 2-3 mutually exclusive options, put the recommended option first, and explain the consequence or tradeoff of each. The user may always answer in free form.
- Ask follow-ups when an answer exposes another material branch. Summarize the decisions already made before moving to the next topic.
- Do not ask low-level implementation questions that a builder can safely decide or current-state questions that repository inspection can answer.
- If the user delegates a choice (for example, "use your judgment"), choose explicitly, record the decision and rationale, and continue. Do not leave the choice inside a task.
- If the user marks a topic out of scope, record it as a non-goal rather than continuing to ask about it.

### Required decision inventory

Resolve or explicitly mark out of scope every applicable category:

- problem, target outcome, and success signal
- users/actors, ownership, roles, and permissions
- canonical terminology and core objects
- primary flows, entry points, completion, and cancellation
- scope, non-goals, variants, and rollout boundary
- states, lifecycle transitions, empty/loading/error/recovery behavior
- data ownership, retention, privacy, audit, migration, and compatibility
- integrations, external dependencies, failure behavior, and fallbacks
- security, abuse/safety constraints, accessibility, performance, and reliability
- analytics, observability, and launch/validation expectations

Not every project needs a question in every category. It does need an explicit answer whenever the category materially applies.

### Alignment checkpoint

After the questions are resolved, present a concise conversational checkpoint containing:

- the agreed product model and primary flows
- the important decisions and defaults
- explicit non-goals
- any bounded research unknowns that will become spike tasks
- the proposed delivery phases and PR relationships, safe interim merge states, activation or cutover phase, and any temporary compatibility mechanism with its removal condition

When the user requested alignment or material choices were made, ask the user to confirm this checkpoint before writing files. Skip the extra confirmation only when the user explicitly authorized the agent to decide and proceed. **Do not create `.tasks/` files while waiting for this confirmation.**

## Process

1. **Understand the full scope and current state.** Read the complete design source and synthesize the conversation. Inspect relevant repository behavior when it can answer current-state questions or expose compatibility constraints.

2. **Build a complete inventory.** Before asking questions or writing tasks, create a checklist of EVERY aspect. Extract:
   - Every feature or behavior described
   - Every user flow or interaction
   - Every data model, schema, or state
   - Every integration or external dependency
   - Every constraint, edge case, or error state
   - Every non-functional requirement (performance, security, accessibility, etc.)
   - Every UI element, page, or component described
   - Every configuration, setting, or admin capability

3. **Build the decision inventory.** Classify gaps as discoverable facts, product decisions, implementation decisions, or bounded research uncertainties. Research discoverable facts first.

4. **Resolve product decisions.** Ask iterative planning-style questions until every material product choice is decided or explicitly out of scope. Do not write task files during this phase.

5. **Confirm alignment.** Present the agreed model, flows, decisions, non-goals, and research unknowns. When required by the alignment checkpoint, wait for confirmation.

6. **Verify design readiness.** Cross-check the resolved design against the source and both inventories. If a task would still need to choose between product outcomes, return to step 4. **Nothing gets dropped and no material choice is deferred to a builder.**

7. **Determine subfolder structure.** Each feature request or project gets **one subfolder** named after the feature (e.g., `image-transforms/`, `custom-domains/`, `org-management/`). Do NOT split a single feature into multiple subfolders by technical concern (e.g., don't create separate `billing/`, `ui/`, `backend/` folders for one feature). All tasks for a feature live together.

   Only create multiple subfolders when the user explicitly requests multiple unrelated features at once — each feature gets its own subfolder.

8. **Group into tasks within the subfolder.** Organize inventory items into coherent, independently buildable tasks. Each task should describe a meaningful outcome, not a technical layer. A task like "user can search files by name" is better than "create search API endpoint."

9. **Design delivery phases.** Map every task to exactly one phase, distinguish semantic phase dependencies from PR-base relationships, and identify the merge-safe state, verification gate, activation boundary, and review budget for each phase. Prefer stacked phases for true dependencies and sibling phases for independent adapters or surfaces that share a stable prerequisite.

10. **Apply the phase-quality and review-size gates.** Split oversized tasks or phases before files are written. Keep one phase only when the single-PR eligibility rule is satisfied. Record any unavoidable size exception and include it in the alignment checkpoint.

11. **Create `.tasks/` directory structure:**
   ```
   .tasks/
   ├── feature-name/
   │   ├── _index.md          # Feature index with context and build order
   │   ├── 001-task-name.md
   │   ├── 002-task-name.md
   │   ├── tech-001-contract.md  # Optional companion spec from tasks-to-tech-specs
   │   ├── ux-001-flow.md        # Optional companion spec from tasks-to-ux-specs
   │   ├── mockups/              # Optional UX mockups from tasks-to-ux-specs
   │   │   ├── ux-flow.html
   │   │   └── figma-handoff.md
   │   └── ...
   ```

12. **Write one markdown file per task** using the format below.

13. **Write the feature `_index.md`** with feature context, resolved decisions, explicit non-goals, task list, dependency/build order, delivery phases, and planned PR topology.

14. **Preserve companion spec and mockup files.** If the feature folder already contains `tech-*.md`, `ux-*.md`, or `.tasks/<feature>/mockups/` files, leave them in place unless the user explicitly asks to regenerate or remove companion artifacts. Do not include them in the `_index.md` task table.

15. **Audit decision and delivery closure.** Search the completed task set for unresolved-decision language such as "decide," "confirm," "TBD," "if desired," "as applicable," "optionally," and "or equivalent." Rewrite product ambiguity as the resolved outcome. Keep "optional" only when optionality itself was an approved behavior. Confirm every task has one phase and every phase passes both gates.

16. **Handoff for companion planning and phased build.** When task decomposition is complete and the user wants implementation details, suggest running `/tasks-to-tech-specs` on the feature folder. When the user wants UX design details, suggest running `/tasks-to-ux-specs`; when they also want a clickable or Figma-ready mockup, suggest `/tasks-to-ux-specs --mockup=html`, `--mockup=figma`, or `--mockup=both`. Use `/build-from-tasks plan` to review the concrete branch and PR stack before `/build-from-tasks build` publishes one phase at a time.

## Task File Format

Every file follows this structure. Name files `NNN-short-name.md` where the number indicates dependency order within the area.

Task IDs are scoped to their feature subfolder: `feature-name/NNN`. For example, `image-transforms/001`, `custom-domains/003`.

```markdown
# Task: [Short Title]

**ID:** area-name/NNN
**Depends on:** [task IDs (area/NNN format) or "none"]
**Blocks:** [task IDs this must complete before]
**Delivery phase:** [P01, P02, ...]
**Estimated scope:** [small | medium | large]
**Estimated effort:** [concrete time range for one builder after dependencies are complete, including verification]
**Status:** todo

## Start Here

[One bounded, implementation-agnostic action that begins this task and names the expected first result.]

## Objective

[1-2 sentences. What outcome does this task produce? Describe the result from the user's or system's perspective, not the technical implementation.]

## Context

[Background the builder needs to understand WHY this task exists. What problem does it solve? How does it fit into the larger system? Reference relevant parts of the design doc.]

## Delivery Context

[State the owning phase's review promise, prerequisite phase and planned PR relationship, what is safe and complete after that phase merges, and which later behavior is deliberately outside this task.]

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

[One runnable command that must exit 0, or one named runtime scenario that must be driven and observed green before this task can be completed.]
```

## Feature Index Format

Each feature subfolder has an `_index.md`:

```markdown
# Feature: [Feature Name]

## Start Here

[Name the first delivery phase and its first task or parallel group, its prerequisite, and the expected reviewable checkpoint.]

**Progress:** 0/[total task count] tasks complete; 0/[total phase count] phases published; 0/[total phase count] phases merged

## Context

[What this feature is and why it matters. Enough background for a builder to understand the feature without reading the full design doc or conversation.]

## Resolved Decisions

- [Material product decisions that all tasks must preserve]

## Out of Scope

- [Explicit non-goals and deferred variants]

## Delivery Strategy

**Mode:** [stacked | sibling | mixed | single]
**Activation or cutover phase:** [Pxx or none; explain when no activation is required]
**Merge order:** [phase order, including which sibling phases may merge in either order]
**Temporary compatibility:** [none, or mechanism + owner + removal phase + removal condition]
**Default review budget:** one reviewer thesis; up to 3 tasks; about 1-2 implementation days; target <=2,500 authored changed lines and <=25 authored files

## Delivery Phases

| Phase | Reviewable outcome | Tasks | Requires | Planned PR relationship | Verification | Status |
|---|---|---|---|---|---|---|
| P01 | [Complete review promise] | 001 | none | root on default branch | [Phase merge gate] | planned |
| P02 | [Complete review promise] | 002, 003 | P01 | stacked on P01 | [Phase merge gate] | planned |
| P03 | [Independent adapter outcome] | 004 | P01 | sibling of P02 from P01 | [Phase merge gate] | planned |

### Phase Details

#### P01 — [Short phase name]

- **After merge:** [Safe, coherent state that exists before later phases]
- **Review budget:** [Expected tasks, effort, authored files/lines, and generated volume separately]
- **Rollback:** [Boundary or recovery expectation]
- **Size exception:** none
- **Branch:** assigned by builder
- **Verified parent:** not recorded
- **Verified implementation:** not recorded
- **PR:** not opened

[Repeat for every phase. If an exception is unavoidable, replace `none` with the approved rationale.]

## Tasks

| ID | Task | Phase | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|---|
| 001 | [Short title] | P01 | small | [concrete range] | todo | none |
| 002 | [Short title] | P02 | medium | [concrete range] | todo | 001 |

## Build Order

[Task dependency chain, phase order, and which tasks can run in parallel inside each phase]

## Parallel Groups

- Group A (no deps): [task IDs]
- Group B (after A): [task IDs]

## PR Topology

[Show roots, stacks, and sibling branches in merge order. Use phase IDs rather than inventing final branch names. If a phase needs multiple sibling predecessors, state that it waits for them to merge before branching from the updated default branch.]

## Next Action

[One action that can be started in under two minutes, usually running `/build-from-tasks plan` to confirm the phase branches and PR bases.]
```

If the feature is large, you may organize tasks into sub-subfolders within the feature folder for clarity (e.g., `.tasks/image-transforms/ui/`, `.tasks/image-transforms/backend/`). The `_index.md` at the feature root still covers all tasks regardless of nesting.

## Companion Spec Files

`tech-*.md` files are optional implementation guidance produced by `tasks-to-tech-specs`. `ux-*.md` files are optional UX design guidance produced by `tasks-to-ux-specs`. Files under `.tasks/<feature>/mockups/` are optional UX mockup artifacts produced by `tasks-to-ux-specs`. They are not task files.

When creating, updating, or reviewing a task breakdown:

- Ignore `tech-*.md`, `ux-*.md`, and `.tasks/<feature>/mockups/` files when choosing the next task number.
- Do not list `tech-*.md`, `ux-*.md`, or `.tasks/<feature>/mockups/` files in `_index.md` task tables, build order, or parallel groups.
- Do not use `tech-*.md`, `ux-*.md`, or `.tasks/<feature>/mockups/` files as `Depends on` or `Blocks` task IDs.
- Preserve existing companion spec and mockup files unless the user explicitly asks to regenerate, replace, or remove them.
- Keep task files implementation-agnostic even when companion specs exist.

## Rules

### Completeness is non-negotiable
- **Every item from the source (design doc or conversation) must appear in a task.** If something was discussed or specified, it's a task or part of a task. Period.
- Complex, ambiguous, or cross-cutting concerns are often the MOST important tasks — don't skip them because they're hard to categorize.
- When in doubt, create the task. It's easier to merge two tasks later than to discover a gap during build.

### Decisions are non-negotiable
- Product decisions are made during design-to-tasks, not assigned to builders as requirements.
- Do not write tasks that ask a builder to choose, confirm, explore, or align on a product outcome.
- Do not hide ambiguity behind words such as "appropriate," "as needed," "if desired," or "where practical" when different interpretations would change behavior.
- A research task must state one answerable unknown, why repository inspection could not resolve it, the evidence to collect, and the decision or follow-on work it will unblock.
- If reviewing or revising an existing task set that contains unresolved product choices, pause file edits, ask the missing questions, confirm alignment, and then replace the ambiguous requirements with the answers.

### Describe goals, not implementation
- Tasks describe **what** needs to be true, not **how** to build it.
- Do NOT specify file paths, frameworks, libraries, or code patterns — the builder will read the project's `AGENTS.md` / `CLAUDE.md` and codebase to determine the right approach.
- Do NOT include "Files to Create/Modify" or "Do NOT Touch" sections — these over-constrain the builder and become stale.
- Requirements should be testable behaviors: "users can search files by name" not "add a search input that calls GET /api/files?q=".

### Tasks must be self-contained
- Each task must be independently buildable by a fresh agent session that has never read the design doc.
- Include ALL context needed in the task file — the Objective, Context, and Requirements sections should give the builder everything they need.
- The builder should be able to execute any task by reading only that task file and the project's instruction file.

### Subfolders are mandatory
- **NEVER place task files directly in `.tasks/`.** Every task MUST live inside a feature subfolder (e.g., `.tasks/image-transforms/001-pricing-toggle.md`, NOT `.tasks/001-pricing-toggle.md`).
- One feature request = one subfolder. All tasks for that feature go in the same subfolder.
- Sub-subfolders within a feature are fine for organization (e.g., `.tasks/image-transforms/ui/`, `.tasks/image-transforms/backend/`).
- The only things allowed directly in `.tasks/` are feature subfolders (and legacy flat files from before this convention). `tech-*.md`, `ux-*.md`, and `mockups/` companion artifacts, when present, belong inside the relevant feature folder beside the source tasks.

### Structural rules
- Number tasks in **dependency order**
- Keep tasks **focused** — one coherent outcome per task
- Prefer **more small tasks** over fewer large ones — easier to parallelize and verify
- Define **interface contracts** between tasks so they can integrate cleanly
- If two tasks would produce conflicting changes, they need clearer boundaries or should be merged
- Assign every task to exactly one delivery phase; do not split one task across PRs
- Keep task dependencies phase-closed: no task may depend on a task in a later phase
- Give each phase one review promise and a phase-local verification gate
- Split provider adapters, workers, Admin surfaces, and migrations at stable interfaces when they are independently reviewable; do not force them together because they serve one feature
- Do not use a final integration phase to hide implementation that belongs in earlier phases
