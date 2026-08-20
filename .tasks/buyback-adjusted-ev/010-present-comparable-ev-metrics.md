# Task: Present Comparable EV Metrics

**ID:** buyback-adjusted-ev/010
**Depends on:** buyback-adjusted-ev/008, buyback-adjusted-ev/009
**Blocks:** buyback-adjusted-ev/011, buyback-adjusted-ev/012, buyback-adjusted-ev/013
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including all public surfaces, responsive behavior, accessibility, and browser verification
**Status:** in_progress

## Start Here

Create one shared presentation matrix for positive, neutral, negative, zero-payout, unavailable, delayed, expired, and sold-out historical results before updating public surfaces.

## Objective

Buyers can compare buyback-adjusted PackScout EV across Dashboard, All Repacks, desired-collectible results, and inspector without confusing it with stated collectible value, vendor EV, Heat, confidence, or a guaranteed single-pack outcome.

## Context

The approved public set contains Gross EV $, Gross EV %, signed EV $, and signed EV %. The browser receives materialized values and must not recreate calculation or confidence logic.

## Requirements

### Shared presentation

- Label Gross EV $ as expected guaranteed buyback payout and Gross EV % as that payout divided by public Pack Price.
- Show EV $ and EV % as signed values above or below Pack Price, with explicit signs for nonzero results.
- Identify the source as `PackScout Gross EV — calculated from platform-provided data` and pair it with `Not financial or gambling advice`.
- Use one shared formatter for precision, signs, semantic states, timestamps, reasons, and accessible descriptions.
- Validate public arithmetic in development and tests without recalculating odds, payouts, confidence, rankings, or aggregate values in the browser.

### Source and state clarity

- Keep vendor-reported EV separately labeled and never average, substitute, or visually merge it with PackScout EV.
- Distinguish valid zero Gross EV, neutral signed EV, unavailable, delayed, expired, simulated, and sold-out historical states.
- Show calculation time, data-as-of time, source age, confidence score and band, and bounded limitations when available.
- Show one stable reason for missing buyback, incomplete evidence, conflict, bad price, unsupported currency, ambiguous draw, stale evidence, and other unavailable states.

### Buyback and confidence

- Present an exact uniform Buyback % only for `uniform_rate`; otherwise show `Varies by outcome`, `Fixed/final payout`, `Not documented`, or `Unavailable` from the public summary.
- Keep EV confidence, Heat confidence, chase-match confidence, buyback summary, and vendor EV semantically separate.

### Surfaces and rankings

- Use signed buyback-adjusted EV dollars for default opportunity, table, and summary ranking.
- Count positive EV only for active current estimates above zero and exclude unavailable, expired, sold-out, and disabled results.
- Show sold-out historical values with no outbound action and keep unavailable repacks discoverable.
- Preserve URL-restorable filters, pagination, desired collectible, selection, saves, Heat, and category behavior.
- Reset or version any old saved/default sort state whose meaning depended on pre-buyback metrics.

### Accessibility and responsive behavior

- Communicate positive, neutral, negative, unavailable, delayed, and historical states with text and signs rather than color alone.
- Use contrast-safe semantic colors, tabular numbers, visible focus, keyboard-operable help, and reduced-motion behavior in both themes.
- Keep the four metrics readable with internal table scrolling at desktop, 390×844, and 200% zoom without page overflow.
- Keep explanations usable in side, bottom, and modal-sheet inspector placements with reliable focus return.
- Avoid passive clock-tick live announcements and preserve server rendering, hydration, and anonymous page availability.

### Deadline behavior

- Convert a current estimate to unavailable at its public expiry deadline even when the backend transition is delayed.

## User-Facing Behavior

At a $100 Pack Price and $85 Gross EV, users see `Gross EV $85.00`, `Gross EV 85.00%`, `EV -$15.00`, and `EV -15.00%`. If PackScout cannot calculate EV, they see `Unavailable` and a reason—not zero or vendor EV.

## Interface Contract

One shared presentation boundary consumes the task 007 PackScout and vendor estimate projections plus price, availability, sold-out, simulated, and freshness state. It returns formatted values, labels, semantic states, reasons, confidence copy, timestamps, and accessible descriptions.

All public catalog surfaces consume that boundary. No component owns a competing EV formula, limitation mapping, break-even threshold, or sort value.

## Acceptance Criteria

- [ ] Positive, neutral, negative, zero, unavailable, delayed, expired, simulated, and historical cases render consistently on every public surface.
- [ ] The `$100 / 85%` example shows all four exact metrics, vendor EV stays separate, and unavailable never becomes zero or a fallback.
- [ ] Rankings, KPI counts, medians, summaries, selected details, URL state, and saves use the approved public semantics.
- [ ] Both themes, desktop, 390×844, keyboard-only, reduced motion, and 200% zoom pass focus, contrast, containment, label, hydration, and console checks.
- [ ] Frontend tests prove no public surface recalculates the business formula or exposes protected evidence.
