# Packscout Project Guide

Packscout is an npm workspace containing two TypeScript applications:

- `apps/frontend/` — Next.js App Router, React 19, and Tailwind CSS.
- `apps/admin/` — React 19 and React Router running through Vite, with an Express server for APIs and production SPA hosting.

Node.js 22 or newer and the root `package-lock.json` are canonical. Do not add package-level lockfiles.

## Canonical documentation

- `ARCHITECTURE.md` — current runtime and dependency shape.
- `docs/framework-standards.md` — ownership, boundaries, and definition of done.
- `docs/framework-standards-adoption-audit.md` — active guardrails, baseline policy, and deliberate deferrals.
- `docs/engineering-rules.md` — project-wide engineering decisions.
- `docs/framework-technical-layout.md` — target feature layouts.
- `docs/frontend-feature-baseline.md` and `docs/admin-feature-baseline.md` — surface-specific checklists.
- `docs/testing/shift-left-bdd.md` — behavior and test requirements.
- `docs/ui-layout-standard.md` — UI and accessibility rules.

If copied code conflicts with these standards, follow the standards and fix the copied pattern.

## Commands

```bash
npm run dev:all
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:framework
```

Use focused package commands during implementation. Use `verify:framework` before handoff.
