# Feature: PackScout Repack Dashboard V1

## Start Here

Open `repack-dashboard/001`, collect one sanitized page example for each provider stream, and finish with an approved live data contract that the catalog snapshot can consume.

**Progress:** 1/12 tasks complete; 11 tasks blocked on live-data, publication, or launch evidence

## Context

PackScout gives repack buyers one public place to answer: “Which current pack offers the strongest estimated value?” V1 combines a catalog Overview, a complete All Packs table, a selected-pack inspector, and three educational guides. The supplied matched light and dark dashboard comps are the visual source of truth; the approved purple PackScout logo kit is the brand source of truth.

Merged data-pipeline PR #1 establishes durable canonical history, quarantine, provider isolation, and PackScout Estimated EV. Its current aggregate feed boundary does not accept the newer provider draft unchanged, and it does not publish a public read model. V1 therefore includes an evidence-backed replacement of that unlaunched feed boundary and a sanitized catalog-snapshot handoff before frontend query work.

## Source Authority

| Priority | Source | Governs |
|---|---|---|
| 1 | This `_index.md` and numbered task PRDs | Resolved V1 product behavior and scope |
| 2 | `docs/design-comps/packscout-frontend/final-dashboard-v1-{light,dark}.png` with `FINAL-REFERENCE.md` hashes | Layout, hierarchy, density, theme parity, and visual direction |
| 3 | Provider stream draft and data-pipeline PR #1 | Live source fields, canonical data, EV evidence, and pipeline constraints |
| 4 | Repository frontend, testing, and UI standards | Architecture boundaries, accessibility, responsive behavior, and verification |
| 5 | `plan.md` and the existing scenario draft | Historical discovery context only; superseded where they conflict |

## Product Model

- V1 is public and anonymous. Dashboard and Learn require no account.
- Dashboard has two real destinations: Overview at `/` and All Packs at `/packs`.
- Learn has an index at `/learn` and exactly three launch articles.
- The header contains PackScout branding, Dashboard/Learn navigation, pack search, public freshness, and a theme control.
- Theme starts from the operating-system preference and persists an explicit light or dark choice on that device.

## Data Ownership Decisions

- PostgreSQL canonical history remains the source of truth; Convex is a rebuildable, sanitized frontend read database.
- Versioned, approved public platform and currency configuration is authoritative in PostgreSQL and is copied into each Convex snapshot; Convex is never its only durable authority.
- The provider draft’s `catalog`, `pulls`, and `trades` streams are the live-launch input. The old aggregate shape is not a fallback for that source.

## Metric and Availability Decisions

- `Gross EV` is the pipeline estimate; `EV $` is Gross EV minus Pack Price; displayed `EV %` is the signed percentage above or below Pack Price.
- Missing, incomplete, or unsupported values display as unavailable with a stable public reason, never as zero or blank; observation age is communicated through freshness status instead of changing pack values.
- V1 comparison values use canonical USD minor units. The public publisher never performs currency conversion; it marks values without approved canonical USD evidence unavailable.
- Overview opportunities include active packs with estimates. All Packs also shows sold-out public listings with a status label and disabled outbound action; disabled listings are excluded.

## Query Interaction Decisions

- Platform and category are multi-select filters; price supports $10 through $12,000. Apply commits draft filters, and Reset immediately restores the full range.
- Without text search, the default order is EV $ high to low. Text search uses relevance order and temporarily replaces metric sorting.
- All Packs returns up to 25 rows per cursor page with Previous/Next controls and URL-restorable query state.
- Pagination cursors bind the snapshot publication and normalized query fingerprint; a new active snapshot starts a coherent first page while preserving valid filters and selection.

## Selection and Action Decisions

- Overview uses a persistent desktop inspector; All Packs uses a bottom preview. Both become an accessible modal sheet on narrow screens.
- Promo copy and Pack Link actions appear only when configured. Pack Links preserve existing parameters and add the approved PackScout referral parameter once.

## Freshness and Reliability Decisions

- “Updated” reflects the latest successful catalog observation for the active complete snapshot, not an individual event time; unchanged content may advance this timestamp without a new snapshot.
- Fresh data has a successful observation at most 15 minutes old and uses a green status. A delayed input or older observation produces amber “Some data delayed” while the last complete snapshot remains usable; Engineering is alerted at 30 minutes.
- A missing initial snapshot produces a recoverable error state; it never renders invented KPI values.
- One coherent dashboard query supplies Overview data so KPI cards, rankings, summaries, and selection share one database state.
- Reactive updates preserve valid filters and selection; removed selections fall back to the first visible pack.

## Product Success Signals

- A buyer can find, compare, inspect, and open a relevant pack without signing in.
- EV values remain explainable and never imply unsupported Net EV, fees, or certainty.
- Anonymous aggregate telemetry can measure searches, applied filters, promo copies, and outbound Pack Link activations without a persistent user identifier.
- Public freshness and query failures are observable without exposing provider diagnostics or tenant identifiers.

## Launch Success Signals

- The launch gate includes real provider contract, backfill, incremental, snapshot-reconciliation, browser, accessibility, and framework verification evidence.
- Product and Engineering owners jointly approve live labeling; the Engineering owner controls rollback to the previous complete snapshot.

## Out of Scope: User Features

- Accounts, cross-device preferences, bookmarks, watchlists, saved filters, alerts, and notifications.
- Comparison trays, social activity, personalization, historical charts, and natural-language search.
- A command palette or search suggestions; the keyboard shortcut only focuses pack search.
- Proprietary user-specific promo codes.
- Mailing-list capture and newsletter workflows.

## Out of Scope: Financial and Content Features

- Net EV, fees and shipping, median outcome, chance of loss, and outlier-adjusted EV.
- Provider-reported EV substituted for PackScout Estimated EV.
- Third-party imagery not supplied by an approved platform feed or listing.
- Terms of Service and Privacy Policy content pending separate legal work.
- A content-management system for the three launch guides.

## External Dependencies

- Merged data-pipeline PR #1 supplies the canonical history and EV foundation on `main`.
- The stream provider must supply sanitized real page envelopes and cursor behavior for `catalog`, `pulls`, and `trades`.
- The Convex development deployment `abundant-puffin-373` now exists and serves the seeded mock catalog. Server-held HMAC publication credentials plus the canonical staging, reconciliation, and activation workflow are still required before live snapshot publication.
- Platform owners must approve public display names, logos, listing hosts, promo codes, and referral parameters.
- Real provider launch evidence must pass before the UI labels the catalog live.

## Tasks: Foundation

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 001 | Lock and adopt the live data handoff | large | 5–8 days | blocked | none |
| 002 | Publish trustworthy catalog snapshots | large | 6–10 days | blocked | 001 |
| 003 | Serve public catalog exploration | large | 4–6 days | blocked | 002 |
| 004 | Establish the branded app shell | medium | 2–4 days | done | none |
| 005 | Present trustworthy EV metrics | medium | 2–3 days | blocked | 003, 004 |

## Tasks: Product Experience

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 006 | Deliver the Dashboard Overview | large | 4–6 days | blocked | 003, 004, 005 |
| 007 | Deliver the All Packs catalog | large | 5–8 days | blocked | 003, 004, 005 |
| 008 | Deliver the pack inspector and actions | large | 4–6 days | blocked | 005, 006, 007 |
| 009 | Publish the Learn guides | medium | 2–4 days | blocked | 004, 005 |
| 010 | Handle data and interface states | medium | 3–5 days | blocked | 006, 007, 008, 009 |

## Tasks: Completion

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 011 | Complete responsive and accessible behavior | medium | 3–5 days | blocked | 004, 006, 007, 008, 009, 010 |
| 012 | Validate and observe the V1 launch | large | 7–10 days | blocked | 001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011 |

## Build Order

### Foundation

1. Run `001` and `004` in parallel.
2. Complete `002`, then `003`.
3. Complete `005` after the data contract and shell exist.

### Product Experience

1. Run `006`, `007`, and `009` in parallel after `005`.
2. Complete `008` after both catalog views exist.
3. Complete `010`, then `011`.
4. Complete `012` only after every earlier acceptance contract is satisfied.

## Parallel Groups

| Group | Ready when | Tasks |
|---|---|---|
| A | immediately | 001, 004 |
| B | 001 complete | 002 |
| C | 002 complete | 003 |
| D | 003 and 004 complete | 005 |

### Product and completion groups

| Group | Ready when | Tasks |
|---|---|---|
| E | 005 complete | 006, 007, 009 |
| F | 006 and 007 complete | 008 |
| G | 008 and 009 complete | 010, then 011, then 012 |

## Next Action

Open `001-lock-live-data-handoff.md`, capture one sanitized real response page for each provider stream, and replace the unlaunched aggregate inbound boundary with the approved stream contract.

## Current Build Handoff

- Done: `004` establishes the complete `apps/frontend` PackScout shell, routes, theme, search, freshness region, and not-found behavior.
- Implemented and verified in local and cloud development but dependency-blocked: the public DTO/read-query foundation, metric presentation, Overview, All Packs, inspector/actions, Learn content, public states, responsive layouts, and strict frontend telemetry/security boundaries. The frontend always reads Convex; a deterministic internal development seed writes one mock snapshot with 9 packs (8 active and 6 Overview opportunities), one bounded query shard, matching bounded detail arrays, and an operation receipt. `dataSource` is required as `mock` or `canonical`, and the shell visibly labels the seeded source as mock data.
- Development workflow evidence: the catalog functions are deployed to `abundant-puffin-373`; the guarded seed returned `created` on its first cloud-development run and `unchanged` on replay without duplicate rows. The frontend server read the deployment over its HTTPS Convex URL, and browser smoke verified visible mock provenance, catalog search, row selection, and inspector replacement. Existing desktop/mobile browser QA also covers mock labeling, search, row selection, and inspector updates against the local Convex backend.
- Live blockers: the provider transport/page/cursor evidence for `001`; the adopted V2 cutover, dual-approved PostgreSQL public configuration, and authenticated Convex publication/HMAC path for `002`; activated canonical snapshots and reactive `preloadQuery`/`usePreloadedQuery` integration for `003`; and durable telemetry/observability, edge enforcement, real 1,500/10,000-pack scale, preproduction/performance evidence, and owner approvals for `012`.
- Status rule: locally implemented UI slices remain `blocked` when an upstream task or launch-evidence acceptance contract is unmet; no task below claims real-provider or live-launch readiness.
