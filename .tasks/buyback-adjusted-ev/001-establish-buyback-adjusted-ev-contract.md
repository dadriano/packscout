# Task: Establish the Versioned Buyback-Adjusted EV Contract

**ID:** buyback-adjusted-ev/001
**Depends on:** none
**Blocks:** buyback-adjusted-ev/002, buyback-adjusted-ev/003, buyback-adjusted-ev/004, buyback-adjusted-ev/007
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder, including the versioned formula, evidence vocabulary, unavailable policy, and contract verification
**Status:** done

## Start Here

Write the canonical examples and rejection matrix first, beginning with a $100 Underlying Outcome EV, an 85% uniform buyback, and a $100 Pack Price producing $85 Gross EV, Gross EV % of 85%, -$15 EV, and -15% EV.

## Objective

PackScout has one strict, versioned input, result, terminology, and evidence contract that every calculator, provider adapter, persistence boundary, publisher, and public surface can implement without redefining the business rules.

## Context

The approved methodology redefines Gross EV as probability-weighted final guaranteed buyback payout. The current pre-buyback midpoint calculation is not the public method for new releases. This task freezes the replacement math and evidence policy before provider mapping, persistence, publication, or UI work proceeds.

## Requirements

### Calculation rules

- Calculate internal Underlying Outcome EV as the probability-weighted supported stated value of every outcome or mutually exclusive outcome bucket.
- Calculate Gross EV $ as the probability-weighted final guaranteed buyback payout of every outcome or bucket.
- Calculate Gross EV % as Gross EV $ divided by Pack Price, EV $ as Gross EV $ minus Pack Price, and EV % as Gross EV % minus 100 percentage points.
- Treat explicitly buyback-ineligible outcomes as zero payout without dropping or renormalizing their probability.
- Apply a uniform product rate only when evidence states that it governs every eligible outcome; exact outcome-specific terms override that rate.

### Numeric rules

- Keep money in integer minor units at owned boundaries and use exact rational arithmetic during weighting.
- Accept probability coverage only when it is within one part per million of 100%; never renormalize accepted or partial source probabilities.
- Use an exact stated value directly and the arithmetic midpoint of a closed range; reject missing, inverted, or open-ended ranges.
- Apply known draw count only under unambiguous per-draw semantics; use one multiplier under per-pack semantics.
- Round once after aggregate weighting, half-up to the currency minor unit; derive percentages from the rounded Gross EV and Pack Price with deterministic half-up basis-point rounding.

### Currency normalization

- Publish PackScout money only as canonical USD cents and preserve each source amount, currency, and precision in protected evidence.
- Accept USD directly and accept only configuration-allowlisted USD-equivalent stablecoins with documented exact 1:1 parity and effective observation time.
- Convert approved stablecoin source amounts to rational USD cents before weighting and defer rounding until final aggregate Gross EV.
- Require Pack Price, stated values, fees, floors, caps, and payout amounts to share the canonical comparison basis before calculation.
- Reject mixed unnormalized money, unsupported precision, missing parity evidence, expired parity approval, and all live FX conversion.

### Buyback payout rules

- Use exactly one payout basis per eligible outcome: an exact documented final payout, or a documented rate from 0 through 10,000 basis points applied to the representative stated value.
- For a rate basis, require percentage fee from 0 through 10,000 basis points and nonnegative fixed fee, apply them to the rated offer in that order, then apply nonnegative floor and cap; require floor at most cap and clamp a negative pre-floor result to zero.
- Treat a fixed guaranteed offer as an exact final payout and forbid additional rate, fee, floor, or cap fields that could apply the terms twice.
- Make absence of documented buyback, unknown eligibility, contradictory bases, material conditional terms, or invalid bounds unavailable; a missing rate is never 100%.
- Reject user-specific, membership-specific, or expiring terms that cannot produce one public guaranteed payout for the represented observation.

### Evidence rules

- Require a positive current public Pack Price, supported currency evidence, complete probabilities, complete values, complete buyback terms, clear draw semantics, source identity, source revision, and source observation time.
- Prefer complete current remaining-inventory odds for finite pools; accept complete current platform-published odds only when current-pool odds are unavailable.
- Define one coherent observation as evidence tied to one provider revision, or one guarded collection transaction that proves no essential input changed; matching timestamps alone are insufficient.
- Reject incoherent observations and published-versus-derived odds conflicts larger than the greater of one basis point or the platform's documented rounding precision.
- Treat recent pulls only as inputs to a verified remaining-inventory revision; never use recent realized frequency as an odds estimator.

### Evidence safety

- Bound every input collection and reject arithmetic outside supported safe-integer and minor-unit limits.
- Require every aggregate bucket to be homogeneous in eligibility and payout function; otherwise expand it into supported outcomes or make the estimate unavailable.

### Confidence and freshness

- Identify the method as `packscout-buyback-adjusted-ev-v1` and the confidence policy as `packscout-buyback-adjusted-ev-confidence-v1`.
- Start every available estimate at 10,000 confidence basis points.
- Deduct 1,500 for platform-published odds, 2,000 when any closed-range midpoint is used, 1,000 for source age over 15 through 30 minutes, and 2,500 for source age over 30 through 60 minutes.
- Map `0–4,999` to Low, `5,000–7,999` to Medium, and `8,000–10,000` to High.
- Make evidence older than 60 minutes unavailable; missing essential evidence never produces a low-confidence available estimate.

### Unavailable outcomes

- Define stable internal reasons for missing buyback, unknown buyback eligibility, incomplete probabilities, incomplete values, invalid value range, and ambiguous draw semantics.
- Define stable internal reasons for invalid price, unsupported currency, odds conflict, non-atomic observation, missing provenance, stale evidence, and arithmetic overflow.
- Map internal detail to a bounded public reason vocabulary that never exposes provider payloads, internal IDs, stack details, or proprietary evidence.
- Preserve all applicable internal reasons in canonical order while returning one deterministic public primary reason.
- Distinguish unavailable from a valid zero-dollar Gross EV and from a valid neutral EV comparison.

## User-Facing Behavior

None directly. The contract fixes the meaning of every future public value and reason; later surfaces must consume those values without recalculating or redefining them.

## Interface Contract

`PackScoutBuybackEvInputV1` carries one coherent observation: Pack Price and currency, unit basis and draw count, source revision and observation time, odds provenance, pool completeness, mutually exclusive outcomes or buckets, supported stated values, buyback eligibility, and final-payout terms.

`PackScoutBuybackEvResultV1` is a strict union:

- Available contains integer-minor-unit `grossEvMoney` and `evDollars`, `grossReturnBasisPoints`, signed `evPercentBasisPoints`, confidence score/band/limitations, method and confidence-policy versions, calculation time, data-as-of time, and sanitized provenance.
- Unavailable contains null metrics and confidence, method and confidence-policy versions, calculation time, data-as-of time when known, an explicit unknown-source-time state otherwise, canonical internal reasons, and one bounded public reason.

`PackScoutBuybackEvConfidenceInputV1` carries only the canonical odds source, midpoint use, oldest essential observation time, calculation time, and availability gate needed to apply the task 003 policy. Task 002 emits this protected shape but does not own its scoring rules.

Underlying Outcome EV may appear in protected calculation evidence but never in the public EV result.

## Acceptance Criteria

- [x] The contract encodes the exact four metrics and the $100 / 85% / $100 golden result without ambiguous aliases.
- [x] Uniform and outcome-specific terms, explicit ineligibility, fixed offers, fees, caps, floors, per-pack, and per-draw evidence have one canonical representation.
- [x] Missing buyback, unknown eligibility, partial probabilities, incomplete values, source conflict, stale evidence, and ambiguous draws map to deterministic unavailable reasons.
- [x] Confidence inputs, limitations, timestamps, method versions, supported currencies, and source provenance have strict bounded representations.
- [x] Unknown fields, unsafe numbers, unordered collections, invalid state combinations, and protected evidence at public boundaries are rejected by adversarial contract tests.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — four metrics and formulas frozen in `PACKSCOUT_BUYBACK_EV_FORMULAS_V1`, golden `$100 / 85% / $100 -> $85 / 85% / -$15 / -15%` fixture, strict input/result/calculation unions, deterministic internal-to-public reason mapping, exact confidence policy encoding
- Divergences: none
- Verification: npm test --workspace @packscout/contracts (153 pass, incl. adversarial input and result boundary tests), typecheck, lint, scan:framework-standards:ratchet (0 new findings); task file predates a ## Verification anchor so the focused package suite is the fallback anchor
