# Feature: Last-Known EV Confidence

## Start Here

Open `last-known-ev-confidence/001`, encode the versioned public freshness policy and the exact 60-minute boundary examples, then prove that a known EV never becomes unavailable because of age alone.

**Progress:** 6/6 tasks complete; ClutchPacks is active on the isolated Convex deployment and browser-certified

## Context

PackScout's buyback-adjusted EV calculation currently treats evidence older than 60 minutes as unavailable. That creates an avoidable information cliff: the economics are still known, but the public catalog removes them instead of communicating that confidence has fallen. This feature keeps calculable EV visible as a last-known estimate, continuously decays its public confidence, and uses provider health only to decide whether a pack may enter Top Opportunities.

The raw `packscout-buyback-adjusted-ev-confidence-v1` calculation record remains immutable and truthful. A separate versioned public freshness policy derives presentation state and confidence at one pinned evaluation time. Existing active Convex release data can adopt the policy without a provider reimport or a PostgreSQL/Neon migration.

## Source Authority

1. This feature PRD and its numbered tasks govern public EV freshness after 60 minutes.
2. `PackScout_Methodology.docx` governs EV definitions, evidence limitations, and responsible-play intent; it does not require a 60-minute availability cutoff.
3. `.tasks/buyback-adjusted-ev` remains the historical V1 calculation and publication record.
4. Repository framework, engineering, BDD, accessibility, and Convex standards govern implementation and verification.

## Resolved Decisions

### Availability

- A calculable EV remains visible and sortable at every evidence age.
- Age alone never changes a known estimate to unavailable and never nulls its economics.
- Unavailable remains reserved for missing or unsupported essential price, odds, value, buyback, currency, draw, or provenance evidence, plus the existing positive-EV suppression policy.
- Sold-out packs retain their historical estimate, freeze freshness at sellout, never rank, and expose no outbound action.

### Public confidence policy

- Through 60 minutes, public confidence applies the existing V1 age bands at the response's pinned evaluation time: no age penalty through 15 minutes, 1,000 points over 15 through 30 minutes, and 2,500 points over 30 through 60 minutes.
- After 60 minutes, state becomes `last_known` and adds the public limitation `source_age_over_60_minutes`.
- Let `C60 = max(0, 7500 - staticPenalties)`, where static penalties are 1,500 for published odds and 2,000 for midpoint value ranges.
- Let `delta = max(0, evaluationTime - dataAsOf - 60 minutes)` and compute `confidence = round_half_up(C60 × 24 hours ÷ (24 hours + delta))`.
- The score is monotonic, bounded from 0 through 10,000, and may round to zero without making EV unavailable.

### Evaluation time and pagination

- Each response uses one authoritative evaluation time for every row, aggregate, detail, and confidence band.
- The first page of a confidence-sorted search pins that evaluation time in its opaque cursor; later pages reuse it.
- Cursor/query validation rejects clocks outside the trusted publication path and prevents caller-selected stale clocks.
- Sold-out packs evaluate confidence at the earlier of sellout time and response evaluation time.

### Provider health

- Evidence freshness controls displayed confidence; provider health controls Top Opportunities eligibility.
- A missing, stale, paused, unhealthy, behind-head, or release-misaligned provider observation excludes its packs from Top Opportunities only.
- Last-known EV remains visible in catalog rows, details, ordinary EV sorting, and overview coverage when provider health excludes it from Top Opportunities.
- Health refreshes are independently observable, monotonic, idempotent, and bound to the exact active public release.

## User Promise

- Buyers never see a previously calculable EV disappear solely because time passed.
- Every aged estimate says `Last-known estimate`, shows when its source evidence was last observed, and carries a decaying confidence score.
- Provider delay is disclosed separately as `Provider feed delayed; excluded from Top Opportunities.`
- PackScout explains that unavailable means required supported inputs are missing; age alone does not make an estimate unavailable.

## Out of Scope

- Recalculating buyback-adjusted economics from provider payloads or changing the EV method version.
- Reimporting ClutchPacks or migrating local PostgreSQL data to Neon.
- Reinterpreting provider-reported EV as PackScout EV.
- Changing the positive-EV suppression policy or sold-out ranking policy.
- Ranking unhealthy provider data in Top Opportunities.

## Tasks

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 001 | Define the public last-known freshness contract | medium | 1 day | done | none |
| 002 | Preserve known estimates through publication | medium | 1 day | done | 001 |
| 003 | Evaluate stable dynamic confidence | large | 2–3 days | done | 001, 002 |
| 004 | Separate provider health from EV availability | large | 2–3 days | done | 001 |
| 005 | Present last-known EV throughout the frontend | large | 2–3 days | done | 003, 004 |
| 006 | Activate and certify ClutchPacks | medium | 1–2 days | done | 002, 003, 004, 005 |

## Build Order

1. Complete `001` to freeze states, formula, version markers, and examples.
2. Complete publication `002`; begin health `004` after the contract lands.
3. Complete dynamic reads `003`, including stable pagination and release compatibility.
4. Complete frontend `005` after reads and health eligibility are stable.
5. Complete ClutchPacks activation and end-to-end certification `006` last.

## External Dependencies

- The local canonical PostgreSQL import remains the source for the initial rollout.
- The `shiny-newt-310` Convex deployment remains the isolated test destination.
- Provider health observations must be signed by the trusted publication boundary.
- Neon migration remains deferred until after the initial import and this rollout.

## Next Action

Open the implementation PR with the completed framework-gate, isolated-deployment, release-certification, and browser-proof results.
