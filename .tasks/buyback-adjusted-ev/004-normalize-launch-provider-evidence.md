# Task: Normalize Launch-Provider EV Evidence

**ID:** buyback-adjusted-ev/004
**Depends on:** buyback-adjusted-ev/001
**Blocks:** buyback-adjusted-ev/006
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including all eight launch-provider fixtures and evidence-quality verification
**Status:** todo

## Start Here

Build one sanitized capability matrix for Courtyard, Collector Crypt, Phygitals, ClutchPacks, GameStop, Beezie, Trove, and Stadium Vault covering every task 001 input.

## Objective

Every launch provider either produces one coherent canonical EV evidence snapshot or an explicit unavailable evidence result without invented odds, values, eligibility, buyback terms, or provider-specific calculator behavior.

## Context

Launch providers expose different pool, tier, value, odds, and buyback shapes. Source-specific interpretation belongs at provider-owned boundaries; the generic calculator must receive the same contract regardless of provider.

## Requirements

### Capability coverage

- Account for public Pack Price, currency, unit basis, draw count, product identity, source revision, and observation time for every provider.
- Account for exact values, closed ranges, final payout values, uniform rates, outcome-specific rates, fixed offers, eligibility, mandatory fees, caps, and floors when supplied.
- Classify odds as complete current remaining-inventory-derived, complete current platform-published, or unavailable.
- Identify whether source values are stated collectible values or final guaranteed payouts so buyback cannot be applied twice.
- Produce canonical unavailable evidence when any essential capability is missing or unsupported.

### Current-pool behavior

- Derive finite-pool odds only from a complete atomic inventory snapshot with stable counts or weights.
- Prefer a complete current pool, use published odds only as the approved fallback, and compare both when they describe the same revision.
- Treat restocks, pool replacements, depletion, price changes, and buyback changes as new evidence revisions.
- Accept separate endpoints only when a provider revision or guarded collection transaction proves no essential input changed; reject mixed revisions and timestamp-only coincidence.
- Use pull records only to derive deterministic remaining inventory, never recent-frequency odds.

### Isolation and safety

- Keep source field interpretation and capability checks within provider-owned normalization boundaries.
- Use common evidence semantics for shared capabilities and never add provider-name branches to generic calculation behavior.
- Preserve sanitized source identity and revision internally while excluding raw records, credentials, and opaque payloads from public projections.
- Normalize semantically equal inputs identically across providers and bound every collection and text field.
- Normalize approved USD-equivalent stablecoins to task 001 parity evidence; fail closed on mixed money, unknown enums, unsupported terms, inventory states, payout bases, or draw semantics.

### Evidence fixtures

- Cover uniform and outcome-specific rates, ineligibility, final-payout sources, fixed offers, fees, caps, and floors.
- Cover exact, closed-range, open-ended, missing, negative, and already-adjusted value cases.
- Cover current-pool odds, published fallback, permitted rounding agreement, material conflict, partial coverage, and non-atomic observations.
- Cover per-pack, per-draw, multi-draw, ambiguous-draw, sold-out, depletion, and restock cases.
- Cover no-buyback and unsupported-currency products that remain discoverable but cannot receive PackScout EV.

### Bucket safety

- Require aggregate buckets to be homogeneous in buyback eligibility and payout function, or expand them into exact supported outcomes before calculation.

## User-Facing Behavior

Supported products can receive PackScout EV. Unsupported products remain discoverable with a sanitized reason; users never see provider parser details or fabricated substitutes.

## Interface Contract

Each provider boundary consumes one sanitized source revision and returns either a complete `PackScoutBuybackEvInputV1` or canonical unavailable evidence. Provider-reported EV flows into its separate public source and never enters this input.

The normalized output is provider-neutral, coherent at one observation boundary, safe for deterministic fingerprinting, and ready for tasks 002 and 003 without additional provider interpretation.

## Acceptance Criteria

- [ ] All eight launch providers have sanitized fixtures and an explicit capability outcome for every required input.
- [ ] Equivalent evidence normalizes identically while source-specific parsing remains outside generic calculation behavior.
- [ ] Current-pool priority, published fallback, rounding tolerance, material conflict, restock, depletion, and pull behavior match the approved policy.
- [ ] Buyback scope, payout basis, eligibility, adjustments, and already-adjusted values cannot be omitted or double-applied.
- [ ] Missing capabilities fail closed without defaults, normalization, provider-EV substitution, raw-payload exposure, or cross-provider leakage.
