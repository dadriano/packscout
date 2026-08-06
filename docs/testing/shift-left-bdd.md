# Shift-Left BDD Testing Standard

Status: canonical testing standard

Features describe behavior before handoff and automate it at the cheapest reliable layer. The goal is readable regression coverage, not test volume for its own sake.

## Scenario standard

Core scenarios live in `.tasks/<feature>/scenarios/*.feature.md` or an equivalent task acceptance map. Use `.tasks/_templates/bdd-scenario.feature.md` when creating a feature plan.

Each acceptance criterion records one of:

- `Automated` — a named test file or command proves it.
- `Manual gap` — automation is currently impractical, with a reason and follow-up.
- `Not applicable` — the criterion has no runtime behavior.

Manual review is not invisible coverage.

## Layer map

| Behavior | Preferred layer |
|---|---|
| Pure formatting, validation, state, and contracts | Unit test beside the helper |
| Reusable server workflow | Future service behavior test |
| Frontend auth, validation, and response mapping | Test beside `apps/frontend/app/api` route |
| Frontend component state and accessibility | Component or focused behavior test |
| Admin auth, role, tenant, validation, and mutation | Test beside `apps/admin/server/routes` |
| Admin forms, tables, dialogs, and states | Page/component behavior test |
| Navigation, responsive layout, and complex interaction | Browser smoke or E2E |

## Test discovery

`scripts/run-tests.mjs` discovers `*.test.ts`, `*.test.tsx`, and root `*.test.mjs` files recursively. Never add a hand-maintained file list.

Known failures belong in `test-quarantine.json` with a repository-relative file, reason, and owner. Missing metadata, duplicate entries, and entries whose files no longer exist fail the runner. Quarantine is temporary and should only shrink.

## Commands

| Command | Scope |
|---|---|
| `npm run test:frontend` | Discovered frontend tests |
| `npm run test:admin` | Discovered admin server and UI tests |
| `npm run test:root` | Repository checker tests |
| `npm test` | All test lanes |
| `npm run check:framework` | Boundaries, docs, scripts, and dependencies |
| `npm run scan:framework-standards:ratchet` | New standards drift and oversized-file growth |
| `npm run verify:framework` | Canonical full gate |

## Security-sensitive paths

Direct boundary coverage is required for authentication, sessions/cookies, authorization and tenant isolation, request validation, secrets/tokens, destructive actions, rate limiting, external writes, and audit behavior. A build or source-string assertion alone is not enough for these paths.

## UI smoke expectations

Use browser verification when a change touches navigation, layout, responsiveness, dialogs/drawers, drag and drop, authenticated routing, or a visually complex workflow. Record the viewport and flow checked in the handoff.

## Review checklist

- [ ] Scenario names describe actor and outcome.
- [ ] Acceptance criteria map to automation or explicit gaps.
- [ ] Invalid, forbidden, empty, conflict, failure, and happy paths are covered where owned.
- [ ] Security-sensitive enforcement has direct tests.
- [ ] Focused checks passed before the full verifier.
