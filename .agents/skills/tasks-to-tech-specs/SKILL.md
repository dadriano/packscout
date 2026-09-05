---
name: tasks-to-tech-specs
description: Create shared, ADHD-friendly implementation-oriented tech-*.md companion specs from a design-to-tasks feature task folder. Use when task files already exist and the agent should ground technical plans in the repository, define code/database/API/interface changes, map specs back to related task IDs, or prepare implementation guidance for build-from-tasks. Trigger with /tasks-to-tech-specs.
disable-model-invocation: true
argument-hint: [.tasks/<feature>/ | path/to/task.md]
---

# Tasks to Tech Specs

Create shared technical specification files for a `.tasks/<feature>/` folder produced by `design-to-tasks`.

The output is implementation guidance for builders. It does not replace task files, `_index.md`, UX specs, or task status tracking.

## ADHD-Friendly Specs

Before writing or updating any spec, read [i-have-adhd](../i-have-adhd/SKILL.md) completely and apply it for the rest of the session.

Tech specs are PRDs for builders. Shape every `tech-*.md` so a builder can act on it immediately:

- Open `Purpose` with the outcome in one sentence. Do not add a `Start Here` section.
- Number every ordered sequence (implementation order, data flow, migration steps). One bounded action per step.
- Cap visible lists at five items. Split longer material into labeled groups; never drop required content to fit.
- State risks, errors, and open questions matter-of-factly: cause, then handling. No alarm framing, no hedging filler.
- No preamble ("This document describes...") and no closing summary — start at the content, end at the content.

ADHD shaping changes presentation, not rigor. Keep every required section, the confirmed-vs-inferred separation, and full coverage of related tasks. If an ADHD rule conflicts with a requirement, keep the requirement and adapt its presentation.

## Input

Accept either:

- a `.tasks/<feature>/` directory
- a task file inside `.tasks/<feature>/`
- no path, only when the feature folder is clear from the conversation

If the input is a task file, resolve its parent feature folder and still read the whole feature. If no feature folder can be inferred, ask for the feature path.

## Required Reading

Before writing specs:

1. Read the repository instruction source, usually `AGENTS.md`, `CLAUDE.md`, or equivalent.
2. Read any referenced architecture or standards docs that govern the touched areas.
3. Read `.tasks/<feature>/_index.md`.
4. Read every non-`tech-*.md` and non-`ux-*.md` task file in the feature folder.
5. Read existing `tech-*.md` files in the feature folder so reruns update or extend the existing spec set instead of duplicating it.
6. Read existing `ux-*.md` files when they affect UI behavior, user flows, accessibility expectations, or implementation sequencing.
7. Inspect the current repository code, schemas, routes, services, generated types, tests, and configuration needed to ground the technical plan.

When any spec touches Convex code, schema, functions, or API patterns, read `convex/_generated/ai/guidelines.md` before proposing Convex changes.

## Output Location and Naming

Write shared specs beside the task files:

```text
.tasks/<feature>/tech-001-data-model-and-migrations.md
.tasks/<feature>/tech-002-api-and-service-contracts.md
.tasks/<feature>/tech-003-ui-integration-flow.md
```

Use dependency order for numbering when clear. Use concise topic slugs. Do not name tech specs like runnable tasks, and do not use `# Task:` headings.

Each tech spec uses an ID in the form `feature-name/tech-NNN`.

## Grouping Rules

Group by technical implementation slice, not by task count.

- Prefer one spec for a shared code, data, API, service, workflow, or UI implementation concern that multiple tasks depend on.
- A spec may relate to one task when that task has a substantial implementation surface.
- Avoid duplicating the same implementation detail across multiple specs.
- Keep task goals in the source task files. The tech spec should explain how the implementation should work.

## Tech Spec Format

Every generated spec must follow this shape:

```markdown
# Technical Spec: [Short Title]

**ID:** feature-name/tech-NNN
**Related tasks:** feature-name/001, feature-name/003
**Depends on technical specs:** none
**Spec status:** draft

## Purpose

## Current System Context

## Proposed Implementation

## Code Changes

## Database / Schema Changes

## Interfaces, APIs, and Endpoints

## Data Flow

## Error Handling and Edge Cases

## Testing and Verification

## Open Questions and Risks

## Handoff Notes
```

Use `**Spec status:**`, never task-style `**Status:**`, so `build-from-tasks` does not treat tech specs as task tracker entries.

## Content Rules

- Include `Related tasks` with canonical task IDs for every task that should read the spec.
- Separate confirmed repository facts from inferred or proposed implementation choices.
- Reference existing files, modules, database tables, routes, generated types, or tests only after inspecting them.
- Describe expected code changes, database or schema changes, interfaces, endpoints, data flow, error handling, and verification.
- Include "none" when a section does not apply, rather than deleting required sections.
- Surface unresolved technical decisions under `Open Questions and Risks`; do not bury them in implementation prose.
- Keep each spec task-focused and concise enough to be useful during implementation.

## Rerun Behavior

When `tech-*.md` files already exist:

1. Read them before generating new specs.
2. Remove any existing `## Start Here` section when updating a spec.
3. Update a matching existing spec when the topic and related task set are substantially the same.
4. Create a new spec only for a new technical slice.
5. Preserve stable spec IDs when updating existing specs; do not delete existing specs unless the user explicitly asks.

## Non-Mutation Rules

Do not edit source task files, `_index.md`, or `ux-*.md` files unless the user explicitly asks. This skill creates and updates only `tech-*.md` companion files.

Do not mark task status, check acceptance criteria, or add spec-compliance notes. Those belong to `build-from-tasks` during implementation.
