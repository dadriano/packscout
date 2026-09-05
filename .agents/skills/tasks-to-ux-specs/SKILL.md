---
name: tasks-to-ux-specs
description: Create shared, ADHD-friendly UX-oriented ux-*.md companion specs from a design-to-tasks feature task folder, optionally with clickable HTML mockups or Figma handoff mockup specs. Use when task files already exist and the agent should define user flows, layout behavior, interaction states, accessibility requirements, content guidance, visual direction, UX acceptance guidance, or mockup artifacts mapped back to related task IDs. Trigger with /tasks-to-ux-specs.
disable-model-invocation: true
argument-hint: "[.tasks/<feature>/ | path/to/task.md] [--mockup=html|figma|both]"
---

# Tasks to UX Specs

Create shared UX design specification files for a `.tasks/<feature>/` folder produced by `design-to-tasks`, with optional mockup artifacts when requested.

The output is design guidance for builders. It does not replace task files, `_index.md`, technical specs, implementation work, or task status tracking.

## ADHD-Friendly Specs

Before writing or updating any spec, read [i-have-adhd](../i-have-adhd/SKILL.md) completely and apply it for the rest of the session.

UX specs are PRDs for builders. Shape every `ux-*.md` so a builder can act on it immediately:

- Open `Purpose` with the intended user outcome in one sentence. Do not add a `Start Here` section.
- Number every ordered sequence (user flows, interaction steps, review passes). One bounded step per item.
- Cap visible lists at five items. Split longer material into labeled groups (for example by screen or state); never drop required content to fit.
- Describe states, feedback, and open questions matter-of-factly: trigger, then behavior. No alarm framing, no hedging filler.
- No preamble and no closing summary — start at the content, end at the content.

ADHD shaping changes presentation, not rigor. Keep every required section, the confirmed-vs-inferred separation, and full coverage of related tasks. If an ADHD rule conflicts with a requirement, keep the requirement and adapt its presentation.

## Input

Accept either:

- a `.tasks/<feature>/` directory
- a task file inside `.tasks/<feature>/`
- no path, only when the feature folder is clear from the conversation

If the input is a task file, resolve its parent feature folder and still read the whole feature. If no feature folder can be inferred, ask for the feature path.

Optional mockup mode:

- `--mockup=html`: also generate a standalone clickable HTML prototype.
- `--mockup=figma`: also generate a Figma-ready handoff spec.
- `--mockup=both`: generate the HTML prototype first, then generate a Figma handoff that references the same screens and states.

Without `--mockup`, create or update only `ux-*.md` specs. With `--mockup`, still perform the normal UX spec pass unless the user explicitly asks for a mockup-only update.

## Required Reading

Before writing specs:

1. Read the repository instruction source, usually `AGENTS.md`, `CLAUDE.md`, or equivalent.
2. Read design, UI, accessibility, or product standards that govern the touched surface.
3. Read `.tasks/<feature>/_index.md`.
4. Read every non-`tech-*.md` and non-`ux-*.md` task file in the feature folder.
5. Read existing `ux-*.md` files in the feature folder so reruns update or extend the existing spec set instead of duplicating it.
6. Read existing `tech-*.md` files when they affect UX feasibility, sequencing, data availability, or interface boundaries.
7. Inspect the current product UI, routes, components, design system primitives, copy patterns, states, and responsive behavior needed to ground the UX plan.
8. When generating mockups, inspect enough of the current implementation to make the mockup a close match to the existing product surface, not a speculative redesign. Favor existing routes, component structure, spacing, color tokens, copy tone, interaction states, and responsive behavior unless the source tasks explicitly request a redesign.

If the UX spec depends on Convex-driven realtime behavior or data availability, read `convex/_generated/ai/guidelines.md` before proposing assumptions about Convex behavior.

## Output Location and Naming

Write shared specs beside the task files:

```text
.tasks/<feature>/ux-001-primary-flow-and-layout.md
.tasks/<feature>/ux-002-empty-error-and-loading-states.md
.tasks/<feature>/ux-003-accessibility-and-responsive-behavior.md
```

When mockup mode is requested, write companion mockup artifacts under:

```text
.tasks/<feature>/mockups/ux-flow.html
.tasks/<feature>/mockups/figma-handoff.md
```

Use dependency order for numbering when clear. Use concise topic slugs. Do not name UX specs like runnable tasks, and do not use `# Task:` headings.

Each UX spec uses an ID in the form `feature-name/ux-NNN`.

Mockup files are companion artifacts. They are not runnable tasks, are not numbered task files, and must not be added to `_index.md` task tables, build order, parallel groups, `Depends on`, or `Blocks`.

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
- When mockup artifacts are created, reference their paths from `Handoff Notes` in the most relevant UX spec.
- Include "none" when a section does not apply, rather than deleting required sections.
- Surface unresolved design decisions under `Open Questions and Risks`; do not bury them in prose.
- Keep specs useful during implementation: concrete enough to guide build decisions, but not a code-level implementation plan.
- Do not invent precise pixel-perfect values unless they are required by an existing design system or provided design artifact.

## HTML Mockup Output

When `--mockup=html` or `--mockup=both` is requested:

- Create or update `.tasks/<feature>/mockups/ux-flow.html`.
- Make it a standalone file with inline HTML, CSS, and JavaScript. Do not add app routes, build config, package dependencies, or external CDN dependencies.
- Build an actual click-through prototype of the primary UX flow, including relevant empty, loading, error, success, disabled, and confirmation states when those states affect the user experience.
- Match the current implementation closely: use inspected product structure, navigation shape, component patterns, copy tone, density, spacing, colors, and responsive behavior.
- Prefer realistic static data that demonstrates the flow. Do not imply real backend persistence, live auth, external integrations, or completed implementation.
- Include accessible labels, keyboard-reachable controls, visible focus states, and responsive layout behavior suitable for review.
- If the environment supports it, open or preview the HTML file and fix obvious layout, click-through, or text-overflow issues before handoff.

## Figma Handoff Output

When `--mockup=figma` or `--mockup=both` is requested:

- Create or update `.tasks/<feature>/mockups/figma-handoff.md`.
- Generate a Figma-ready handoff document, not a live Figma file update.
- Include frame inventory, screen/state descriptions, component mapping, reusable patterns, visual tokens, text styles, spacing guidance, screen copy, responsive notes, and prototype link mapping.
- Map frames and components back to inspected current-product patterns and related task IDs.
- For `--mockup=both`, reference the HTML prototype screens and states so the Figma handoff stays aligned with the clickable mockup.
- Do not claim that a Figma file was created or updated unless a separate, successful Figma tool or plugin workflow actually did that work.
- If direct Figma creation is needed later, treat it as a separate plugin/API workflow; this skill's v1 Figma output is a handoff artifact.

## Rerun Behavior

When `ux-*.md` files already exist:

1. Read them before generating new specs.
2. Remove any existing `## Start Here` section when updating a spec.
3. Update a matching existing spec when the topic and related task set are substantially the same.
4. Create a new spec only for a new UX slice.
5. Preserve stable spec IDs when updating existing specs; do not delete existing specs unless the user explicitly asks.

When mockup files already exist and mockup mode is requested:

1. Read the existing mockup artifact before replacing it.
2. Update `.tasks/<feature>/mockups/ux-flow.html` in place for the same primary UX flow.
3. Update `.tasks/<feature>/mockups/figma-handoff.md` in place for the same Figma handoff.
4. Preserve useful reviewed decisions, frame names, prototype step names, and screen/state coverage when they still match the source tasks.
5. Create additional mockup files only when the user explicitly asks for multiple separate flows.

## Non-Mutation Rules

Do not edit source task files, `_index.md`, or `tech-*.md` files unless the user explicitly asks. This skill creates and updates only `ux-*.md` companion files and requested files under `.tasks/<feature>/mockups/`.

Do not mark task status, check acceptance criteria, add spec-compliance notes, or present mockups as implemented product behavior. Those belong to `build-from-tasks` during implementation.
