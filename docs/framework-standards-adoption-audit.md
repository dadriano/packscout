# Framework Standards Adoption Audit

Status: active foundation scorecard  
Last updated: 2026-08-04

Packscout starts with two application surfaces, `frontend` and `admin`, and a zero-debt standards goal. This scorecard records which engineering guardrails are active now, which boundaries are intentionally deferred, and the command that proves the repository is ready to hand off.

## Active guardrails

| Guardrail | Enforcement |
|---|---|
| Application and runtime boundaries | [`scripts/check-boundaries.mjs`](../scripts/check-boundaries.mjs) rejects imports between the applications, imports between the admin browser and server zones, and server-only imports from browser code. |
| Documentation integrity | [`scripts/check-docs.mjs`](../scripts/check-docs.mjs) requires the canonical documents, checks local Markdown links, and rejects copied product/path vocabulary and draft review markers. |
| Script safety | [`scripts/check-scripts.mjs`](../scripts/check-scripts.mjs) rejects destructive or environment-specific package scripts that do not declare their scope. |
| Workspace and dependency integrity | [`scripts/check-dependencies.mjs`](../scripts/check-dependencies.mjs) enforces Node/npm workspace metadata, one root lockfile, and explicit, owned, expiring vulnerability exceptions. |
| Test discovery | [`scripts/run-tests.mjs`](../scripts/run-tests.mjs) discovers tests by convention and fails on missing coverage lanes or malformed, duplicate, or stale quarantine entries. |
| Architecture ratchet | [`scripts/scan-framework-standards.mjs`](../scripts/scan-framework-standards.mjs) reports boundary drift, oversized modules, inline-style hotspots, route-test gaps, missing BDD scenarios, workspace drift, and missing focused quality commands. |
| Behavior planning | [The BDD standard](testing/shift-left-bdd.md) and [scenario template](../.tasks/_templates/bdd-scenario.feature.md) require acceptance criteria to map to automation or an explicit gap. |
| Admin HTTP failure boundary | `apps/admin/server/app.ts` rejects malformed JSON and unknown API routes with stable `{ error, code }` responses before the SPA fallback. |
| Admin interaction foundation | The shared admin shell, theme tokens, client API helper, dialog, confirmation, toast, status, and empty-state patterns establish one reusable UI contract. |

The contributor-facing sources of truth are [the framework standard](framework-standards.md), [the engineering rules](engineering-rules.md), and [the technical layout](framework-technical-layout.md).

## Zero-debt baseline

The first committed `docs/framework-standards-scan-baseline.json` must contain zero findings. It is a ratchet reference, not a waiver list:

- new findings fail verification,
- resolved findings stay resolved,
- an oversized module may not grow beyond the recorded tolerance,
- refreshing the baseline requires deliberate review and must never be used only to make CI green.

Temporary exceptions must identify an owner, a reason, and an expiry or removal condition. Packscout does not inherit another repository's accepted debt or quarantine entries.

## Deliberate deferrals

### Authentication route generation

Packscout does not yet have an authentication model, protected route tree, or middleware contract. A generated protected-path manifest and drift checker will be added when those decisions are real. Until then, contributors must not invent an auth-path generator or imply that placeholder routes are protected.

The admin shell makes this deferral visible as `Access controls pending`; this is a warning, not an authorization control. The first protected admin route must add server enforcement and direct denial-path tests before the label can be removed.

### Shared services and data access

There is no shared service package, database client, or persistence model yet. `frontend` and `admin` therefore remain independent applications with explicit browser/server boundaries. When reusable business behavior or persistence gains a second caller, introduce the transport-neutral service boundary, public package exports, single data-client ownership, migrations, and focused service tests together. Do not duplicate the behavior or document a fictional package in advance.

## Canonical verification

Before handoff and in CI, run:

```bash
npm run verify:framework
```

This is the one canonical gate. It runs the framework checks and standards ratchet, then linting, type checks, convention-discovered tests, and production builds for both applications. Focused commands are encouraged during implementation, but they do not replace the full verifier.
