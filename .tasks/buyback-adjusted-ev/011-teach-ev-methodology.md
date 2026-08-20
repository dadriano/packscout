# Task: Teach the EV Methodology and Limitations

**ID:** buyback-adjusted-ev/011
**Depends on:** buyback-adjusted-ev/010
**Blocks:** buyback-adjusted-ev/013
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder, including glossary, Learn content, responsible-play review, and content verification
**Status:** in_progress

## Start Here

Write the shared `$100 stated Outcome EV × 85% buyback = $85 Gross EV` explanation and its positive, neutral, negative, and unavailable companion examples.

## Objective

Buyers can understand what PackScout Gross EV means, how buyback changes it, why it can be unavailable, what confidence measures, and which economic factors PackScout does not model.

## Context

The methodology uses platform-provided price, odds, inventory, value, and buyback data. PackScout does not independently value collectibles at launch, and recent pulls do not predict the next pack. Education must use the same terminology and rendered examples as the comparison UI.

## Requirements

### Formula education

- Explain Underlying Outcome EV as protected intermediate stated value and Gross EV as expected guaranteed buyback payout.
- Explain Gross EV %, signed EV $, signed EV %, Pack Price, and the 100% break-even point distinctly.
- Include exact positive, neutral, negative, valid-zero, unavailable, and `$100 / 85%` worked examples through shared presentation behavior.
- Explain uniform versus outcome-specific terms, ineligibility, fixed offers, fees, caps, floors, and no double-discounting; show Buyback % only for a uniform rate.
- State that EV is a long-run expectation and never guarantees one opening.

### Evidence and limitations

- Explain current remaining-inventory odds priority, published-odds fallback, material conflict, complete-coverage requirements, and non-atomic rejection.
- Explain exact values, midpoint limitations, stale evidence, confidence penalties, and why missing essential evidence is unavailable rather than low confidence.
- Explain that recent pulls affect EV only through deterministic remaining inventory and that hot or cold streaks do not estimate future odds.
- Explain vendor-reported EV as a separate source that never fills or changes PackScout EV.
- Explain excluded liquidity, shipping, resale fees, taxes, personalized prices, unsupported FX, and independent market valuation.

### Trust and responsible play

- Label platform-derived claims and observation times without overstating verification or independence.
- State that confidence measures evidence reliability, not the likelihood of profit.
- Use `Not financial or gambling advice` anywhere the compact methodology promise appears.
- Verify and use the current official National Council on Problem Gambling call, text, and help-link information at release time.
- Keep the official contact review as a release check so a stale document number is never treated as permanent source truth.

## User-Facing Behavior

Glossary and Learn use the same words, numbers, states, and reasons as the catalog. A reader can tell why a Gross EV % of 85% is 15% below break-even and why no-buyback evidence means unavailable rather than 100% or zero by assumption.

## Interface Contract

Education consumes the task 010 presentation examples and bounded public limitation vocabulary. It does not duplicate formulas in separately maintained hard-coded numbers.

The content registry exposes one canonical definition for every EV term and one approved responsible-play resource block for all Learn and glossary surfaces.

## Acceptance Criteria

- [ ] Glossary and Learn accurately explain all four metrics, buyback application, break-even, evidence priority, confidence, freshness, and unavailable behavior.
- [ ] Positive, neutral, negative, zero, unavailable, and `$100 / 85%` examples match the shared presentation values exactly.
- [ ] Platform provenance, vendor-EV separation, non-predictive pulls, excluded costs, and model non-goals are explicit.
- [ ] Responsible-play and disclaimer copy use the verified current official resource and pass content-owner review.
- [ ] Content tests prevent terminology, example, reason, link, and accessible-help drift across public surfaces.
