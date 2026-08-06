# Frontend Feature Baseline

Status: canonical frontend standard

The frontend uses Next.js App Router and React. It owns public route composition, server loading, browser interaction, and frontend HTTP adapters.

## Route and component shape

- Prefer server components for access resolution and initial loading.
- Mark interactive components with `"use client"` and keep them browser-safe.
- Separate server-only helpers with a `.server.ts` suffix and browser-safe helpers with `.client.ts` when both exist.
- Do not add empty folders solely to mirror the target layout.

## API route order

1. Authenticate when the route is not public.
2. Authorize the exact resource or action.
3. Validate params, query, headers, and body at the boundary.
4. Delegate reusable behavior to its service owner.
5. Map failures to `{ error, code? }` and an appropriate status.
6. Return a stable response shape.

Health routes must expose liveness only—no secrets, environment values, dependency credentials, or internal diagnostics.

## User-visible states

Decide loading, empty, validation, forbidden, not-found, conflict, failure, success, dirty, and destructive-confirmation behavior where the feature can reach those states. Prefer feedback close to the owning action.

## Handoff checklist

- [ ] Client and server boundaries are intact.
- [ ] Public inputs are validated and errors are structured.
- [ ] Security-sensitive decisions have direct tests.
- [ ] Reachable UI states are represented.
- [ ] Keyboard, focus, labels, contrast, and reduced motion are preserved.
- [ ] Responsive and navigation changes received a browser smoke pass.
- [ ] Focused tests, lint, typecheck, and the frontend build pass.
