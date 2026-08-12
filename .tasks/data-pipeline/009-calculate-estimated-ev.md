# Task: Calculate PackScout Estimated EV

**ID:** data-pipeline/009  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/003](003-persist-source-and-canonical-history.md), [data-pipeline/007](007-project-catalog-and-inventory-data.md)  
**Blocks:** [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md), [data-pipeline/018](018-validate-backfill-and-incremental-launch.md)  
**Estimated scope:** large  
**Status:** done

## Objective

PackScout produces a transparent gross EV estimate when provider inputs are sufficient and a stable unavailable result when they are not, without presenting the result as exact or overwriting provider-reported EV.

## Context

The feeds do not provide a complete item-level inventory for every pack. V1 therefore uses the midpoint of each provider-supplied probability bucket and labels every result **PackScout Estimated EV**. Exact EV and independent market valuation are outside scope.

An estimate requires complete usable probabilities and finite lower and upper value bounds. Values must be USD or a verified USD stablecoin treated at one dollar. Open-ended buckets, partial chase lists, incomplete probabilities, unsupported currencies, ambiguous draw semantics, or a missing pack price produce an unavailable result with evidence instead of an invented number.

## Requirements

### Calculation rules

- Calculate a bucket midpoint as `(lower_value + upper_value) / 2` and a per-basis estimate as the sum of `probability × midpoint` across the complete distribution.
- Apply draw count only when adapter evidence declares the distribution `per_draw`; do not multiply a `per_pack` distribution.
- Produce estimated gross EV and EV percentage, defined as estimated gross EV divided by current pack price times one hundred.
- Require finite non-negative bounds, finite non-negative probabilities, probability coverage equal to one hundred percent within one documented tolerance, supported currency, unambiguous basis, positive draw count, positive pack price, and source evidence for every included bucket.
- Treat configured verified USD stablecoins as one USD. Do not convert other currencies or assume that an unknown token address is a stablecoin.

### Status, provenance, and history

- Return status `estimated` with value and evidence or status `unavailable` with one or more constrained reason codes; never return status `exact`.
- Keep provider-reported EV, provider update time, and PackScout estimate in separate fields. Do not substitute provider EV when PackScout inputs are unavailable.
- Persist calculation method and version, input source revision IDs, input coverage, included bucket count, source timestamp, calculation timestamp, currency policy, result, and reason codes as canonical history plus a current estimate.
- Recalculate when a current pack price, distribution, bounds, currency support, basis, draw count, or related input revision changes. Equivalent inputs and method version produce no duplicate estimate revision.
- Expose calculation evidence downstream without exposing raw provider JSON.

## User-Facing Behavior

Downstream consumers see `PackScout Estimated EV`, its percentage of pack price, an as-of time, and a concise methodology or coverage explanation. When calculation is unavailable, the pack remains visible with a specific reason such as incomplete probability coverage, missing value bound, unsupported currency, ambiguous draw basis, or missing price. Provider-reported EV remains separately labelled.

## Interface Contract

The calculator accepts a current pack price and currency plus an EV-input set containing probability buckets, value bounds, currency, basis, draw count, source revision IDs, and source time. It returns:

```text
EstimatedEvResult {
  status: estimated | unavailable
  gross_value: number | null
  ev_percent: number | null
  currency: USD | null
  method_version: string
  coverage_percent: number
  input_count: number
  source_at: timestamp | null
  calculated_at: timestamp
  reason_codes: string[]
}
```

The calculator is deterministic for the same inputs and method version and has no provider-name branches or external price calls.

## Acceptance Criteria

- [x] Complete per-pack and per-draw fixtures produce the documented midpoint estimate and EV percentage with deterministic rounding and evidence.
- [x] Incomplete probabilities, invalid bounds, open-ended buckets, unsupported currency, unknown token, missing price, invalid draw count, and ambiguous basis produce unavailable results with stable reasons.
- [x] Provider-reported EV remains unchanged and separately identifiable whether PackScout EV is estimated or unavailable.
- [x] Relevant source changes create calculation history, equivalent inputs are idempotent, and every result identifies method version, source revisions, coverage, source time, and calculation time.
- [x] Tests prove the shared calculator is provider-neutral and never labels a result exact or calls an external valuation or currency service.

## Spec Compliance

- Added a deterministic integer/rational midpoint calculator with aggregate half-up rounding, explicit probability tolerance, per-pack/per-draw semantics, and allowlisted USD/stablecoin policy.
- Made incomplete inventory, missing/open bounds, incomplete coverage, unsupported currencies, ambiguous basis, invalid draw count, and missing price explicit unavailable reasons instead of synthetic values.
- Persisted source-linked `estimated_ev` canonical revisions with method/version, input manifest, fingerprint, coverage, timestamps, limitations, and a browser-safe explanation DTO.
- Proved relevant-input and method changes revise history, equivalent inputs remain idempotent, and provider-reported EV stays separate from PackScout Estimated EV.
- Enqueued changed pack and EV-input revision pairs atomically with page persistence, then composed bounded, lease-based, restart-safe worker processing through the shared calculator and canonical history repository.
- Made verified USD-stablecoin parity an explicit fail-closed worker configuration; no stablecoin is trusted when the deployment allowlist is unset.
