# Feature: Buyback-Adjusted PackScout EV

Status: planned — implementation not started
Owner: product build

## Scenario: A buyer sees the approved buyback-adjusted calculation

Given a $100 Pack Price, complete outcomes with $100 Underlying Outcome EV, and a documented uniform 85% buyback
When PackScout calculates and presents the repack
Then Gross EV is $85 and Gross EV % is 85%
And EV $ is -$15 and EV % is -15%

Coverage: Manual gap — automated calculator, public-contract, and presentation coverage is owned by tasks `buyback-adjusted-ev/002`, `007`, and `010` and does not exist yet.

## Scenario: Outcome-specific buyback terms govern payout

Given complete mutually exclusive outcomes with exact eligibility, rates, fixed offers, mandatory fees, caps, and floors
When PackScout calculates Gross EV
Then each outcome contributes its final guaranteed buyback payout weighted by its probability
And an explicitly ineligible outcome contributes zero without removing or renormalizing its probability

Coverage: Manual gap — automated calculation and provider-normalization coverage is owned by tasks `buyback-adjusted-ev/002` and `004` and does not exist yet.

## Scenario: Missing buyback never becomes a 100% assumption

Given a discoverable repack with complete values and odds but no documented buyback
When PackScout evaluates its EV evidence
Then PackScout Gross EV is unavailable with a bounded public reason
And vendor-reported EV remains separate and the repack does not enter EV rankings

Coverage: Manual gap — automated calculator, public-query, and presentation coverage is owned by tasks `buyback-adjusted-ev/002`, `008`, and `010` and does not exist yet.

## Scenario: Combined payout terms use one deterministic order

Given a rate-based outcome with a percentage fee, fixed fee, floor, and cap
When PackScout determines its guaranteed payout
Then it applies stated value times rate, percentage fee, fixed fee, floor, and cap in that order
And contradictory bases, invalid bounds, and heterogeneous aggregate buckets make EV unavailable

Coverage: Manual gap — automated contract, calculation, and provider-normalization coverage is owned by tasks `buyback-adjusted-ev/001`, `002`, and `004` and does not exist yet.

## Scenario: Approved stablecoin evidence normalizes before weighting

Given complete money evidence in an allowlisted USD-equivalent stablecoin with documented 1:1 parity
When PackScout calculates EV
Then every input is converted to rational canonical USD cents before weighting and rounded once after aggregation
And mixed unnormalized, unsupported, or expired parity evidence makes EV unavailable

Coverage: Manual gap — automated currency-contract, calculation, and provider-normalization coverage is owned by tasks `buyback-adjusted-ev/001`, `002`, and `004` and does not exist yet.

## Scenario: Buyback presentation never invents one average rate

Given products with a uniform rate, outcome-specific terms, exact final payouts, no documented buyback, and unsupported terms
When PackScout presents their buyback evidence
Then it shows the corresponding bounded public summary for each product
And it displays a numeric Buyback % only for the uniform-rate product

Coverage: Manual gap — automated public-contract, presentation, and education coverage is owned by tasks `buyback-adjusted-ev/007`, `010`, and `011` and does not exist yet.

## Scenario: Current finite-pool odds take priority

Given one atomic current remaining-inventory snapshot and current platform-published odds for the same product revision
When PackScout normalizes calculation evidence
Then complete current-pool odds govern the calculation
And a material conflict larger than the approved tolerance makes the estimate unavailable rather than choosing the more favorable source

Coverage: Manual gap — automated provider-evidence and conflict coverage is owned by task `buyback-adjusted-ev/004` and does not exist yet.

## Scenario: Partial evidence is not normalized or extrapolated

Given incomplete probabilities, unknown eligibility, missing values, an open-ended range, ambiguous draws, or non-atomic observations
When PackScout evaluates the repack
Then the estimate is unavailable with deterministic internal and public reasons
And PackScout does not normalize, extrapolate, substitute provider EV, or present a low-confidence partial calculation

Coverage: Manual gap — automated strict-contract, calculation, normalization, and public-projection coverage is owned by tasks `buyback-adjusted-ev/001`, `002`, `004`, and `007` and does not exist yet.

## Scenario: A supported midpoint lowers confidence without changing availability

Given complete evidence whose only value limitation is at least one closed platform-provided range
When PackScout uses the range midpoint
Then the estimate remains available and receives the exact 2,000-point midpoint penalty
And the public presentation identifies the midpoint limitation without exposing protected evidence

Coverage: Manual gap — automated calculator, confidence, and presentation coverage is owned by tasks `buyback-adjusted-ev/002`, `003`, and `010` and does not exist yet.

## Scenario: Freshness changes confidence and then expires EV

Given one otherwise complete available estimate
When its source age crosses 15, 30, and 60 minutes
Then it receives the approved 1,000-point or 2,500-point confidence penalty at the applicable interval
And after 60 minutes PackScout marks EV unavailable and excludes it from rankings without changing it to zero

Coverage: Manual gap — automated clock-bound policy, release-state, query, and presentation coverage is owned by tasks `buyback-adjusted-ev/003`, `008`, and `010` and does not exist yet.

## Scenario: Recent pulls do not predict future outcomes

Given a sequence of recently reported pulls
When no verified remaining-inventory revision can be derived from them
Then they do not change PackScout odds or Gross EV
And no hot or cold recent streak is presented as predictive evidence

Coverage: Manual gap — automated provider-normalization and education coverage is owned by tasks `buyback-adjusted-ev/004` and `011` and does not exist yet.

## Scenario: A sold-out repack retains historical context without ranking

Given a sold-out repack whose last complete EV calculation is current for its final available observation
When a buyer finds it in the catalog
Then PackScout shows timestamped historical Gross EV with sold-out wording
And it freezes the original confidence, has no outbound action, and does not appear in EV rankings or positive-EV KPIs

Coverage: Manual gap — automated confidence, public-query, and presentation coverage is owned by tasks `buyback-adjusted-ev/003`, `008`, and `010` and does not exist yet.

## Scenario: Publication cannot mix calculation methods

Given historical pre-buyback revisions and new buyback-adjusted revisions
When a public release is staged and validated
Then only the exact approved method and confidence-policy versions can enter the new release
And a mixed, malformed, conflicting, partial, or failed release cannot replace the active coherent release

Coverage: Manual gap — automated persistence, public-contract, publication, tamper, and rollback coverage is owned by tasks `buyback-adjusted-ev/005`, `007`, `008`, and `012` and does not exist yet.

## Scenario: EV remains understandable and accessible

Given positive, neutral, negative, unavailable, delayed, expired, and historical states
When a buyer uses Dashboard, All Repacks, inspector, desired-collectible results, glossary, or Learn
Then all four metrics, source distinction, confidence, limitations, timestamps, and reasons remain consistent and understandable without color
And both themes, keyboard, reduced motion, narrow screens, and 200% zoom remain usable

Coverage: Manual gap — automated presentation and education coverage plus browser evidence is owned by tasks `buyback-adjusted-ev/010`, `011`, and `013` and does not exist yet.

## Scenario: Launch provenance traces source to browser

Given one sanitized real example from each launch provider
When Product and Engineering review the preproduction release
Then every displayed metric traces through normalized evidence, canonical fingerprint, method version, public release, query, and browser presentation
And no protected evidence, raw provider payload, credential, user identity, or old EV interpretation crosses the public boundary

Coverage: Manual gap — preproduction end-to-end evidence and owner approval is owned by task `buyback-adjusted-ev/013` and does not exist yet.
