# Task: Calculate Deterministic Buyback-Adjusted EV

**ID:** buyback-adjusted-ev/002
**Depends on:** buyback-adjusted-ev/001
**Blocks:** buyback-adjusted-ev/005
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including pure calculation, edge cases, and adversarial verification
**Status:** todo

## Start Here

Turn the task 001 golden examples into executable calculator cases, starting with `$100 × 85% = $85`, `85%`, `-$15`, and `-15%`.

## Objective

PackScout deterministically converts one complete canonical evidence snapshot into exact buyback-adjusted money and percentage metrics, or returns a constrained unavailable result without assumptions or partial estimates.

## Context

The existing estimator weights platform value ranges before buyback. The approved method instead weights each outcome's final guaranteed buyback payout. A uniform rate is only shorthand for identical outcome terms, and recent hit frequency never enters the calculation.

## Requirements

### Weighted payout

- Calculate Underlying Outcome EV from stated values as protected evidence and Gross EV from final guaranteed payouts as the public economic result.
- Apply exact outcome-specific terms before a documented uniform rate, and count explicit ineligibility as zero payout without removing its probability.
- Apply the task 001 payout basis and exact rate-fee-fixed-fee-floor-cap order while preventing an exact final payout from being adjusted again.
- Apply draw count only under explicit per-draw semantics and use one multiplier under per-pack semantics.
- Keep vendor-reported EV completely outside the PackScout calculation.

### Exactness and coverage

- Use integer-safe or exact rational arithmetic through aggregation and round once, half-up, to the supported currency minor unit.
- Require probability coverage within one part per million of 100%; never normalize missing or accepted source probability mass.
- Use exact values directly and arithmetic midpoints only for complete closed ranges; reject open, inverted, missing, negative, or unsafe values.
- Derive Gross EV %, EV $, and EV % from rounded Gross EV and positive public Pack Price with deterministic basis-point rounding.
- Reject heterogeneous aggregate buckets, overflow, non-finite output, invalid draw count, invalid payout terms, and unsupported currency as unavailable.

### Result behavior

- Return the task 001 available result only when every essential input is complete and mutually coherent.
- Return all applicable internal reasons in canonical order and one bounded public primary reason when unavailable.
- Distinguish missing buyback from a documented 0% buyback and distinguish zero Gross EV from neutral EV.
- Set data-as-of to the oldest essential observation used and keep calculation time separate.
- Produce byte-equivalent results for byte-equivalent canonical inputs.

## User-Facing Behavior

None directly. Downstream features receive authoritative values and never reconstruct the formula in Convex or the browser.

## Interface Contract

The calculator accepts `PackScoutBuybackEvInputV1` and an explicit calculation clock. It returns the metrics or unavailable state in `PackScoutBuybackEvResultV1`, plus protected Underlying Outcome EV and `PackScoutBuybackEvConfidenceInputV1` defined by task 001.

It performs no network, provider, persistence, publication, logging, or wall-clock work. Provider identity cannot alter generic arithmetic.

## Acceptance Criteria

- [ ] Golden positive, neutral, negative, zero-payout, uniform-rate, outcome-specific, fixed-offer, fee, cap, floor, per-pack, and per-draw cases produce exact results.
- [ ] Missing terms, unknown eligibility, incomplete coverage, bad ranges, ambiguous draws, unsupported currency, invalid price, and overflow fail closed with deterministic reasons.
- [ ] Probability mass is never normalized, buyback is applied exactly once, vendor-reported EV never enters the result, and recent pulls never estimate odds.
- [ ] Exact arithmetic and single-boundary rounding pass threshold, large-value, repeated-run, and canonical-order tests.
- [ ] The public four-metric relationships remain mathematically consistent for every available generated case.
