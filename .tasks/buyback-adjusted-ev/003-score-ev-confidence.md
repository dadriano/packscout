# Task: Score EV Evidence Confidence and Freshness

**ID:** buyback-adjusted-ev/003
**Depends on:** buyback-adjusted-ev/001
**Blocks:** buyback-adjusted-ev/005, buyback-adjusted-ev/007
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder, including policy derivation, time boundaries, and adversarial verification
**Status:** done

## Start Here

Encode the exact score table and boundary examples for fresh complete evidence, published-odds fallback, midpoint values, delayed evidence, and evidence older than 60 minutes.

## Objective

Every available PackScout EV receives one reproducible confidence score, band, limitation set, and freshness state that describe evidence reliability without implying profitability or outcome certainty.

## Context

Confidence is separate from return. Missing essential evidence is unavailable rather than low confidence. The policy is intentionally small and versioned so a score can be explained and recomputed from bounded public limitations.

## Requirements

### Policy calculation

- Identify the policy as `packscout-buyback-adjusted-ev-confidence-v1` and start every available result at 10,000 basis points.
- Deduct 1,500 for platform-published odds fallback and 2,000 when at least one closed-range midpoint is used.
- Apply no freshness penalty through 15 minutes, 1,000 over 15 through 30 minutes, and 2,500 over 30 through 60 minutes.
- Add approved penalties, clamp at zero, and map Low to `0–4,999`, Medium to `5,000–7,999`, and High to `8,000–10,000`.
- Permit no other V1 penalty or score adjustment.

### Time and availability

- Measure source age from the oldest essential source observation in the coherent calculation snapshot.
- Treat exactly 15, 30, and 60 minutes according to the inclusive boundaries above.
- Make evidence older than 60 minutes unavailable and omit confidence rather than retaining a low score.
- Make missing essential observation time unavailable with an explicit unknown-source-time state.
- Keep calculation time, data-as-of time, source age, and expiry deadline distinct and ordered.

### Meaning and output

- Emit limitations in canonical order with no duplicate codes and no free-form provider text.
- Keep EV sign, magnitude, Heat, vendor-reported EV, and chase-match confidence out of the score.
- Require every available result to have confidence and every unavailable result to have null confidence.
- Provide bounded public explanations for each score-affecting condition.
- Reject unsupported policy versions, impossible score-band pairs, and inconsistent time states.

## User-Facing Behavior

Users can see why an estimate is High, Medium, Low, delayed, historical, or unavailable without reading confidence as a chance of profit.

## Interface Contract

The confidence boundary consumes `PackScoutBuybackEvConfidenceInputV1` from task 001. It returns policy version, score, band, canonical limitation codes, source-age state, and expiry deadline, or an unavailable freshness result after 60 minutes.

Task 002 emits the protected confidence input alongside each calculation. Downstream tasks publish only the bounded score, band, limitations, policy version, timestamps, and deadline—not the protected evidence used to derive them. Sold-out historical wrapping is owned by task 007 and does not recompute the original score.

## Acceptance Criteria

- [x] Every penalty combination and the exact 15-, 30-, and 60-minute boundaries produce the approved score, band, limitation set, and availability.
- [x] Positive, neutral, and negative EV with identical evidence receive identical confidence.
- [x] Missing essential evidence and evidence older than 60 minutes cannot produce an available low-confidence result.
- [x] Sold-out history, calculation time, data-as-of time, limitation ordering, and unsupported-version states validate deterministically.
- [x] Public explanation copy remains bounded and never exposes provider payloads or claims confidence measures return.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — `evaluatePackScoutBuybackEvConfidenceV1` in `packages/services/src/buyback-adjusted-ev-confidence.ts` applies the exact V1 penalty table with inclusive 15/30/60-minute boundaries, canonical limitation ordering, bounded explanation copy, and fail-closed version/time validation; every output parses through the task-001 evaluation contract. Sold-out historical wrapping deferred to task 007 per this task's interface contract.
- Divergences: a failed availability gate whose known evidence is still current (age <= 60 min) throws instead of returning an unavailable evaluation, because the contract's unavailable branch only admits expired or unknown-source-time freshness; the canonical task-002 failed-gate output carries a null observation time so this edge is unreachable in the pipeline, and failing closed honors "never fabricate a score". Revisit at task 006 wiring if recomputation ever routes fresh failed gates here.
- Verification: node --import tsx --test src/buyback-adjusted-ev-confidence.test.ts (11 pass, independently re-run by the orchestrator), eslint clean; package-wide suite deferred to the Group B integration checkpoint. Task file predates a ## Verification anchor; focused suite is the fallback anchor.
