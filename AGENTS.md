# Packscout Contributor Instructions

These instructions apply to every human and automated contributor.

Before changing code, read:

1. `docs/framework-standards.md`
2. `docs/engineering-rules.md`
3. The relevant frontend or admin baseline
4. `docs/testing/shift-left-bdd.md`
5. `docs/ui-layout-standard.md` for user-facing work

## Required discipline

- Keep `frontend` and `admin` independent. Browser code must not import server code.
- Put reusable business behavior behind a future shared service boundary rather than copying it between apps.
- Validate inputs at public HTTP boundaries and return stable, structured errors.
- Treat auth, permissions, secrets, destructive actions, and tenant isolation as security-sensitive and cover them directly with tests.
- Do not add compatibility shims, dual reads, dual writes, or provider-specific branches to generic code without an approved design and removal condition.
- Environment-specific or destructive utilities belong under `scripts/local`, `scripts/preproduction`, or `scripts/live`; package script names must make their scope explicit.
- Preserve unrelated user changes and never use destructive Git operations without explicit approval.

## Definition of done

Run the focused checks while working. Before handoff, run:

```bash
npm run verify:framework
```

The verifier is the canonical local and CI gate. Do not bypass, weaken, or baseline a new finding merely to make it pass.

When the `design-to-tasks` workflow is invoked, treat it as planning only. Do not implement until the user explicitly asks to execute the tasks.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
