---
name: prd
description: Draft a PRD markdown file in docs/prd/ optimized for decomposition by /design-to-tasks. Use when starting a new feature, planning a project, or preparing requirements for task generation.
user-invocable: true
argument-hint: <feature-name> [--from path/to/notes.md]
---

# Draft PRD

Draft a Product Requirements Document as a markdown file in `docs/prd/`, structured specifically for downstream consumption by `/design-to-tasks`.

## How It Works

1. **Gather context.** Use `$ARGUMENTS`, conversation history, and any referenced files to understand what needs to be built.
2. **Collaborate with the user.** Ask clarifying questions if the scope, constraints, or behaviors are ambiguous. Don't guess — ask.
3. **Write the PRD.** Create `docs/prd/<feature-name>.md` using the template below.
4. **Review with the user.** Present the PRD and ask if anything is missing or wrong before finalizing.

## Argument Parsing

- First positional argument is the feature name (used for the filename, kebab-cased).
- `--from path/to/file.md` — read an existing notes/brainstorm file as input context.
- If no arguments, ask the user what they want to build.

## Output

Write the PRD to `docs/prd/<feature-name>.md`. Create the `docs/prd/` directory if it doesn't exist.

After writing, tell the user:
> PRD written to `docs/prd/<feature-name>.md`. Run `/design-to-tasks docs/prd/<feature-name>.md` to decompose it into buildable tasks.

## PRD Template

The PRD must follow this structure. Every section is mandatory — if a section doesn't apply, write "N/A" with a brief reason. The goal is to give `/design-to-tasks` everything it needs to produce complete, self-contained task files.

```markdown
# PRD: [Feature Name]

**Status:** Draft
**Author:** [name]
**Date:** [YYYY-MM-DD]

---

## Problem Statement

[2-3 sentences. What problem exists today? Who is affected? What's the cost of not solving it?]

---

## Goals

[Bulleted list of what this work achieves. Be specific and measurable where possible.]

### Non-Goals

[Explicitly what this work does NOT include. This prevents scope creep during task decomposition.]

---

## User Stories

[List every user-facing behavior. Each story should map to one or more tasks downstream.]

### Story: [Short title]
**As a** [persona], **I want to** [action], **so that** [outcome].

**Acceptance Criteria:**
- [ ] [Observable behavior]
- [ ] [Edge case or error state]
- [ ] [Integration point]

[Repeat for each story. Don't consolidate — more granular stories produce better tasks.]

---

## Functional Requirements

[Detailed behavioral requirements organized by area. Each requirement should be testable.]

### [Area 1]
- FR-1: [Requirement description]
- FR-2: [Requirement description]

### [Area 2]
- FR-3: [Requirement description]
- FR-4: [Requirement description]

---

## Non-Functional Requirements

- **Performance:** [Response times, throughput, concurrency targets]
- **Security:** [Auth, authorization, data protection, input validation]
- **Accessibility:** [Standards, device support]
- **Reliability:** [Error handling, recovery, data integrity]

---

## Data Model

[Describe entities, relationships, and state transitions. If modifying existing models, describe the changes.]

### New Entities
- **EntityName:** [fields and purpose]

### Modified Entities
- **EntityName:** [what changes and why]

### State Transitions
[Describe any state machines or lifecycle flows]

---

## UI/UX

[Describe every screen, component, and interaction. Focus on what the user sees and does, not implementation.]

### [Screen/Flow 1]
- [What the user sees]
- [What they can do]
- [What happens when they do it]
- [Error states and empty states]

### [Screen/Flow 2]
- [Same structure]

---

## API / Interface Design

[Describe the contract — endpoints, commands, events, or integration points. Be specific about inputs and outputs.]

### [Endpoint/Interface 1]
- **Input:** [what goes in]
- **Output:** [what comes out]
- **Errors:** [what can go wrong]

---

## Technical Considerations

[Architecture decisions, constraints, dependencies, migration concerns. Include anything that would affect how tasks are structured.]

- [Consideration 1]
- [Consideration 2]

---

## Edge Cases & Error States

[Enumerate scenarios that are easy to overlook. These often become their own tasks.]

- [Edge case 1: what happens when...]
- [Edge case 2: what happens when...]
- [Error state 1: what happens when...]

---

## Dependencies

[External systems, other features, or prerequisites that must exist first.]

- [Dependency 1]
- [Dependency 2]

---

## Open Questions

[Unresolved decisions. Flag these clearly — they may block task decomposition.]

1. [Question 1]
2. [Question 2]
```

## Writing Rules

### Optimize for task decomposition
The primary consumer of this PRD is `/design-to-tasks`. Every behavior, screen, endpoint, and edge case you describe will become (or be part of) a task. Be exhaustive. If you skip something, it won't get built.

### Be specific about behaviors, not implementation
Describe what the system does, not how it's coded. "Users can filter by date range" is good. "Add a DateRangePicker component with onChange handler" is too prescriptive.

### Every acceptance criterion must be observable
"Code is clean" is not observable. "Filtering by date range returns only items within the selected range" is observable.

### Include edge cases explicitly
Don't assume the task decomposer will infer edge cases. If an empty state, error state, or boundary condition matters, write it down.

### Non-goals are as important as goals
Clearly stating what's out of scope prevents `/design-to-tasks` from generating tasks for work you don't want done.

### Keep user stories granular
One story per distinct user action or behavior. A story that says "user can manage their settings" is too broad — break it into "user can change display name", "user can update email", etc.

### Reference the codebase
If this feature touches existing code, mention the relevant areas (e.g., "extends the existing pipeline stage lifecycle", "adds a new tab to the initiative detail view"). This helps task decomposition produce accurate context sections.

### Resolve open questions before handoff
Try to resolve open questions with the user during the drafting process. Unresolved questions create ambiguous tasks. If questions truly can't be resolved yet, flag them prominently so the task decomposer can handle them.
