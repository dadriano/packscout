# Admin Feature Baseline

Status: canonical admin standard

The admin console uses a Vite/React SPA backed by Express. It owns dense operator workflows, browser API helpers, and admin transport adaptation.

## Feature shape

```text
apps/admin/server/routes/<feature>.ts
apps/admin/src/api/<feature>.ts
apps/admin/src/pages/<Feature>Page.tsx
apps/admin/src/components/<feature>/
apps/admin/src/hooks/<feature>/
```

## Express route standard

Routes must identify intentionally public endpoints, such as liveness checks,
explicitly. All other routes must:

- authenticate before work begins,
- make tenant and role boundaries explicit,
- validate every public input,
- delegate shared behavior instead of copying it,
- return structured errors with appropriate statuses, and
- preserve stable response shapes.

Auth/session, role changes, tenant changes, secrets/tokens, destructive deletes, audit-sensitive mutations, and external writes require direct route tests.

## Client API and UI standard

- Browser requests go through `apps/admin/src/api` helpers once a feature has more than a trivial single call.
- Pages use the existing shell, layout, tokens, tables, forms, dialogs, banners, and empty states before adding local alternatives.
- Inline styles are reserved for truly dynamic values.
- Destructive controls require confirmation and clear consequences.

## Foundation already available

- `src/layouts/AdminLayout.tsx` owns responsive navigation and global chrome.
- `src/theme.css` and `src/index.css` own light/dark tokens and shared classes.
- `src/api/client.ts` owns credentials, JSON encoding, and structured API errors.
- `src/components/AdminDialog.tsx` owns modal labelling, focus entry/return, focus trapping, and Escape behavior.
- `src/providers/confirm.tsx` owns destructive tiers, typed acknowledgment, pending state, and action failure feedback.
- `src/providers/toast.tsx` owns non-blocking success and failure announcements.

Extend these contracts when a real feature needs more capability. Do not fork them in a page or copy server request logic into a browser component.

## Handoff checklist

- [ ] Auth, role, and tenant boundaries are explicit.
- [ ] Inputs are validated and errors are structured.
- [ ] Browser code imports no server-only modules.
- [ ] Loading, empty, invalid, forbidden, failure, success, dirty, and destructive states are represented where applicable.
- [ ] Security-sensitive routes have direct regression tests.
- [ ] Admin lint, tests, typecheck, build, and relevant browser smoke checks pass.
