# Packscout Framework Standards

Status: canonical contributor standard

This document defines the current architecture and quality bar. It should be read with `engineering-rules.md` and `framework-technical-layout.md`.

## Base frameworks

| Surface | Framework | Ownership |
|---|---|---|
| Frontend | Next.js App Router, React 19, Tailwind CSS | Public routes, server components, frontend API adapters, and user-facing interaction. |
| Admin | Vite, React 19, React Router 7, Express | Operator UI, admin client API helpers, and Express transport adapters. |

Node.js 22+, npm workspaces, and the root lockfile are project standards.

## Core rules

- UI renders state and coordinates interactions; it does not own persistence or authorization policy.
- HTTP adapters authenticate, authorize, validate, delegate, and map structured responses.
- Reusable business behavior belongs behind a transport-neutral service boundary when it has multiple callers.
- Runtime-neutral helpers should be shared only after genuine reuse exists.
- Infrastructure remains generic-first and provider details stay isolated.
- Compatibility paths are designed, owned, tested, and removable.

## Package boundaries

- No relative or package import may cross between `frontend` and `admin`.
- `apps/admin/src` is browser code; `apps/admin/server` is server code.
- A frontend file marked `"use client"` cannot import Node-only or server-only modules.
- Future shared packages must expose public entry points. Imports containing `/src/` across package boundaries are rejected.
- Use `npm run check:boundaries` after changing imports, app layouts, or package manifests.

## Frontend standard

Target feature shape:

```text
apps/frontend/app/<route>/page.tsx
apps/frontend/app/<route>/<Feature>Client.tsx
apps/frontend/app/api/<resource>/route.ts
apps/frontend/components/<feature>/
apps/frontend/hooks/<feature>/
apps/frontend/lib/<feature>.server.ts
apps/frontend/lib/<feature>.client.ts
```

Use only the folders the feature needs. Server components load data and resolve access; client components own browser interaction. API routes return stable JSON and do not become business-service modules.

Detailed checklist: `frontend-feature-baseline.md`.

## Admin standard

Target feature shape:

```text
apps/admin/server/routes/<feature>.ts
apps/admin/src/api/<feature>.ts
apps/admin/src/pages/<Feature>Page.tsx
apps/admin/src/components/<feature>/
apps/admin/src/hooks/<feature>/
```

Admin routes make auth, tenant, role, validation, and error boundaries explicit. Pages use the shared shell and established controls before introducing one-off UI.

Detailed checklist: `admin-feature-baseline.md`.

## Testing and BDD

- Feature behavior is described in `.tasks/<feature>/scenarios/*.feature.md` or an equivalent task acceptance map.
- Tests are discovered by convention; never hand-register individual test files.
- A failing test may be quarantined only with a file, reason, and owner. Stale quarantine entries fail the gate.
- Security-sensitive boundaries require direct tests. Builds alone are insufficient.
- UI changes involving layout, navigation, responsive behavior, or complex interaction require a browser smoke pass.

Detailed standard: `testing/shift-left-bdd.md`.

## Standards ratchet

`npm run scan:framework-standards:ratchet` rejects new architecture findings and growth of already-oversized modules. The baseline records accepted current state; it is not a suppression list to refresh casually. Packscout begins with a zero-finding baseline.

## Standard feature checklist

- Identify the owning surface and any secondary consumer.
- Record core Given/When/Then scenarios and their coverage mapping.
- Keep browser/server and app/app boundaries intact.
- Validate every public input and map errors consistently.
- Cover happy, invalid, empty, forbidden, conflict, failure, and destructive states where applicable.
- Add direct tests for security-sensitive behavior.
- Run focused checks, then `npm run verify:framework` before handoff.
- Document any temporary exception with its owner and removal condition.
