---
name: tasks-to-ux-specs
description: Create shared UX-oriented `ux-*.md` companion specs from a `design-to-tasks` feature task folder. Use when task files already exist and Codex should define user flows, layout behavior, interaction states, accessibility requirements, content guidance, visual direction, and UX acceptance guidance mapped back to related task IDs.
---

# Tasks to UX Specs

Create shared UX design specification files for a `.tasks/<feature>/` folder produced by `design-to-tasks`.

The output is design guidance for builders. It does not replace task files, `_index.md`, technical specs, or task status tracking.

## Input

Accept either:

- a `.tasks/<feature>/` directory
- a task file inside `.tasks/<feature>/`
- no path, only when the feature folder is clear from the conversation

If the input is a task file, resolve its parent feature folder and still read the whole feature. If no feature folder can be inferred, ask for the feature path.

## Required Reading

Before writing specs:

1. Read the repository instruction source, usually `AGENTS.md`, `CLAUDE.md`, or equivalent.
2. Read design, UI, accessibility, or product standards that govern the touched surface.
3. Read `.tasks/<feature>/_index.md`.
4. Read every non-`tech-*.md` and non-`ux-*.md` task file in the feature folder.
5. Read existing `ux-*.md` files in the feature folder so reruns update or extend the existing spec set instead of duplicating it.
6. Read existing `tech-*.md` files when they affect UX feasibility, sequencing, data availability, or interface boundaries.
7. Inspect the current product UI, routes, components, design system primitives, copy patterns, states, and responsive behavior needed to ground the UX plan.

If the UX spec depends on Convex-driven realtime behavior or data availability, read `convex/_generated/ai/guidelines.md` before proposing assumptions about Convex behavior.

## Output Location and Naming

Write shared specs beside the task files:

```text
.tasks/<feature>/ux-001-primary-flow-and-layout.md
.tasks/<feature>/ux-002-empty-error-and-loading-states.md
.tasks/<feature>/ux-003-accessibility-and-responsive-behavior.md
```

Use dependency order for numbering when clear. Use concise topic slugs. Do not name UX specs like runnable tasks, and do not use `# Task:` headings.

Each UX spec uses an ID in the form `feature-name/ux-NNN`.

## Grouping Rules

Group by user experience slice, not by task count.

- Prefer one spec for a shared journey, surface, layout system, interaction pattern, state model, or accessibility concern that multiple tasks depend on.
- A spec may relate to one task when that task has a substantial UX surface.
- Avoid duplicating the same UX requirement across multiple specs.
- Keep task goals in the source task files. The UX spec should explain the intended experience and design constraints.
- Use existing product patterns unless the task explicitly calls for a new pattern.

## UX Spec Format

Every generated spec must follow this shape:

```markdown
# UX Spec: [Short Title]

**ID:** feature-name/ux-NNN
**Related tasks:** feature-name/001, feature-name/003
**Depends on UX specs:** none
**Spec status:** draft

## Purpose

## User Goals and Success Criteria

## Current UX Context

## Information Architecture and Navigation

## Interaction Model

## Layout and Responsive Behavior

## States and Feedback

## Accessibility

## Visual Design Direction

## Content and Microcopy

## Design System and Component Notes

## Cross-Spec and Technical Dependencies

## QA and Review Checklist

## Open Questions and Risks

## Handoff Notes
```

Use `**Spec status:**`, never task-style `**Status:**`, so `build-from-tasks` does not treat UX specs as task tracker entries.

## Content Rules

- Include `Related tasks` with canonical task IDs for every task that should read the spec.
- Separate confirmed product/UI facts from inferred or proposed UX choices.
- Reference existing routes, pages, UI components, tokens, copy patterns, and responsive behavior only after inspecting them.
- Describe user flows, navigation, layout behavior, interaction states, content, accessibility, responsive expectations, and review criteria.
- Include "none" when a section does not apply, rather than deleting required sections.
- Surface unresolved design decisions under `Open Questions and Risks`; do not bury them in prose.
- Keep specs useful during implementation: concrete enough to guide build decisions, but not a code-level implementation plan.
- Do not invent precise pixel-perfect values unless they are required by an existing design system or provided design artifact.

## Rerun Behavior

When `ux-*.md` files already exist:

1. Read them before generating new specs.
2. Update a matching existing spec when the topic and related task set are substantially the same.
3. Create a new spec only for a new UX slice.
4. Preserve stable spec IDs when updating existing specs.
5. Do not delete existing specs unless the user explicitly asks.

## Non-Mutation Rules

Do not edit source task files, `_index.md`, or `tech-*.md` files unless the user explicitly asks. This skill creates and updates only `ux-*.md` companion files.

Do not mark task status, check acceptance criteria, or add spec-compliance notes. Those belong to `build-from-tasks` during implementation.


## Output shape for the human reader

Spec bodies are for builders — complete and precise, never compressed for readability. The handoff message is for a human:

1. First line: which spec files now exist and in which folder.
2. One line per spec: what it covers and the task IDs it maps to.
3. At most 3 decisions or risks that need human eyes, ranked.
4. Last line: one concrete next action — usually the follow-on skill to run or the one decision you need.

Simplification never applies to spec content.
- Before the session's first user-facing summary, load the `eli5` skill (Skill tool, audience: "a busy technical reader who skims"); if unavailable, apply purpose-first, plain-word calibration directly.
- If `/i-have-adhd` is active it outranks these; never invoke it yourself (user-invocable only).
