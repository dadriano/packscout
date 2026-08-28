# Task: Define the Replacement Public EV Contract

**ID:** buyback-adjusted-ev/007
**Depends on:** buyback-adjusted-ev/001, buyback-adjusted-ev/003
**Blocks:** buyback-adjusted-ev/008
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including strict public schemas, invariants, fixtures, and compatibility removal
**Status:** done

## Start Here

Write strict current, historical, and unavailable projections plus the positive, neutral, negative, no-buyback, delayed, expired, and sold-out fixtures they must accept.

## Objective

Every public consumer receives one safe versioned PackScout EV shape whose labels, arithmetic, confidence, reasons, and timestamps have buyback-adjusted meaning and cannot be confused with old pre-buyback or vendor-reported EV.

## Context

The semantic change requires a clean public contract replacement. The contract must expose enough information for trustworthy presentation and sorting while excluding Underlying Outcome EV, per-outcome terms, formulas, and protected source evidence.

## Requirements

### PackScout estimate states

- Define a current state with all four metrics, confidence, method versions, calculation time, data-as-of time, source-age state, and expiry deadline.
- Define a sold-out historical state with the last estimate that was current at recorded sellout, its original confidence and timestamps, `soldOutAt`, and explicit historical labeling; it never expires into a live unavailable state.
- Define an unavailable state with null metrics and confidence, method and confidence-policy versions, known timestamps, unknown-source-time state when needed, and one bounded public reason.
- Validate every available money and percentage relationship against public Pack Price using the approved rounding policy.
- Require the exact buyback-adjusted calculation and confidence-policy versions for the new release contract.

### Freshness and history

- Permit historical wrapping only when the last completed estimate was at most 60 minutes old at a known `soldOutAt`; otherwise publish unavailable history.
- Freeze historical metrics, confidence, limitations, calculation time, and data-as-of time at the final valid observation.
- Require current estimates to carry a canonical expiry deadline exactly 60 minutes after the oldest essential observation.
- Keep current estimates valid through the exact 60-minute deadline and reject them only after that deadline, even when stored freshness state has not advanced.
- Distinguish valid zero Gross EV, neutral signed EV, delayed current EV, expired unavailable EV, and historical sold-out EV.

### Buyback summary

- Publish `uniform_rate` with basis points only when one documented rate governs every eligible outcome and no nonlinear terms apply.
- Publish `varies_by_outcome` when eligibility, rates, or payout functions differ across outcomes.
- Publish `fixed_or_final_payout` when exact payout amounts govern without one honest product-wide rate.
- Publish `not_documented` when buyback evidence is missing and `unavailable` when terms exist but cannot be safely summarized.
- Never expose per-outcome formulas, protected term details, or a synthetic average buyback percentage.

### Source separation and privacy

- Keep vendor-reported EV structurally independent with its own source money, normalized comparison when available, and observation time.
- Forbid substitution, averaging, fallback, and consistency requirements between vendor and PackScout estimates.
- Exclude Underlying Outcome EV, payout formulas, source manifests, provider payloads, internal reason collections, and proprietary revisions.
- Limit public limitations and reasons to a canonical allowlist with approved human meaning.
- Reject unknown fields and raw-like or protected keys at every nested boundary.

### Release interface

- Introduce `data_release_v3` and remove the prior EV interpretation from active new contract exports and fixtures.
- Carry the same PackScout projection through repack summary, detail, dashboard, list, desired-collectible, and selected-item results.
- Materialize only bounded sortable values and null ranks required by public reads.
- Keep Heat, chase-match confidence, availability, actions, and category relationships independent from EV confidence.
- Make release and page/detail consistency validation fail closed on semantic or arithmetic divergence.

## User-Facing Behavior

Public consumers can render the four approved metrics, confidence, source timing, buyback summary, history, and unavailable reason from one projection without performing business calculations.

## Interface Contract

The replacement release contract is `data_release_v3`. Each repack exposes `evEstimates.packScout` as the strict current/historical/unavailable public union derived from task 001 results and `evEstimates.vendorReported` as an independent source.

All public result envelopes preserve active release identity and carry byte-equivalent EV projections for the same repack and revision.

## Acceptance Criteria

- [x] Current, historical, unavailable, zero, neutral, positive, negative, delayed, expired, and sold-out fixtures validate with exact semantics.
- [x] Inconsistent arithmetic, versions, confidence, timing, nullability, protected fields, and unknown nested fields are rejected.
- [x] Vendor-reported EV stays independent, while uniform, variable, fixed/final, undocumented, and unavailable buyback summaries remain honest and bounded.
- [x] Summary, detail, dashboard, list, desired-collectible, sort-row, and selected-item projections remain aligned and bounded.
- [x] No alias, dual contract, mixed interpretation, or runtime fallback to pre-buyback Gross EV remains in the new public surface.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — `data_release_v3` contract in `packages/contracts/src/data-release-v3*.ts`: strict current/sold-out-historical/unavailable `evEstimates.packScout` union with exact method/policy versions, half-up arithmetic reconciliation against public pack price, 60-minute expiry deadline with reference-clock rejection, frozen sold-out history, bounded buyback summary enum, structurally independent vendor EV, byte-equivalent projections across summary/detail/dashboard/list/desired-collectible/sort-row, protected-key rejection at every nesting level, and an explicit test that the pre-buyback v2 shape cannot enter v3. v2 files intentionally untouched — they remain the active runtime contract until the task-008 cutover.
- Divergences: none identified (builder agent was interrupted before writing its final report; the orchestrator completed verification and reviewed exports/tests directly).
- Verification: npm test --workspace @packscout/contracts (177 pass — 24 new v3 tests), typecheck clean, lint clean, all independently re-run by the orchestrator after the interruption. Task file predates a ## Verification anchor; the contracts package suite is the fallback anchor.
