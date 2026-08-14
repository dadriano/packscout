# Task: Present Trustworthy EV Metrics

**ID:** repack-dashboard/005
**Depends on:** repack-dashboard/003, repack-dashboard/004
**Blocks:** repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/009, repack-dashboard/012
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including metric and glossary verification
**Status:** blocked

## Start Here

Create one presentation example for positive, neutral, negative, and unavailable PackScout Estimated EV using the approved formulas and copy below.

## Objective

Give every Dashboard surface one explainable metric vocabulary so buyers can compare packs without confusing gross return, expected advantage, provider claims, or unavailable evidence.

## Context

The pipeline stores `evPercent` as Gross EV divided by Pack Price times 100, so break-even is 100. The snapshot exporter materializes the signed EV percentage and EV dollar advantage once under the shared formulas below. Public presentation consumes those authoritative fields while retaining pipeline Gross EV unchanged.

Net EV, fees, shipping, and provider-reported EV substitution are out of scope. A missing estimate is a normal state because incomplete probabilities, inventory, currencies, and source evidence can make calculation unavailable.

## Requirements

### Metric Formulas

- `Gross EV` equals PackScout’s estimated gross content value before fees or shipping.
- `EV $` equals Gross EV minus Pack Price in the same supported currency.
- Displayed `EV %` equals the pipeline gross-return percentage minus 100 percentage points.
- `Positive` is greater than 0.00%, `Neutral` is exactly 0.00%, and `Negative` is less than 0.00%.

### Numeric Representation

- Money remains integer minor units until localized display formatting.
- Dollar comparison uses canonical USD minor units supplied by the pipeline; presentation code never converts provider currencies.

### Trust and Availability

- Label the estimate “PackScout Estimated EV” and pair Dashboard metrics with “Not financial advice.”
- Keep provider-reported EV separate from PackScout Estimated EV and omit it from V1 comparison fields.
- Show `Unavailable` with concise public reason copy when the estimate, USD comparison price, supported currency evidence, buyback, or chase representative value is missing.
- Never show an unavailable value as zero, `0%`, an empty cell, or a positive/negative state.
- Explain that EV is a long-run estimate and does not predict an individual pack outcome.

### Semantic Presentation

- Display an explicit plus or minus sign with EV $ and EV % when the value is nonzero.
- Pair color with visible Positive, Neutral, Negative, or Unavailable text or icon semantics.
- Keep positive green, negative red, neutral text-toned, and unavailable muted with accessible contrast in both themes.
- Use tabular number alignment in dense comparisons.
- Format currencies and percentages consistently across KPI cards, tables, inspector, and Learn examples.

### Glossary

Every All Packs column has an enabled-by-default definition.

### Identity definitions

| Column | Public definition |
|---|---|
| Platform | The marketplace or provider offering the pack |
| Category | The collectible family represented by the pack |
| Pack | The provider’s public listing name |

### Value definitions

| Column | Public definition |
|---|---|
| Pack Price | The amount charged to open or buy the pack |
| EV $ | PackScout Gross EV minus Pack Price |
| EV % | The percentage PackScout Gross EV is above or below Pack Price |
| Buyback % | Provider-supported buyback coverage relative to Pack Price, supplied directly or derived from documented provider terms |
| Gross EV | PackScout’s estimated value of contents before fees and shipping |

### Chase and action definitions

| Column | Public definition |
|---|---|
| Top Chase | The highest-valued eligible related collectible currently identified |
| Top Chase Value | The supported canonical representative value attached to that collectible |
| Promo Code | A public platform-approved code available to copy |
| Pack Link | The tracked outbound link to the provider listing |

## User-Facing Behavior

Users can focus, hover, or activate a metric hint to read its definition. Semantic state remains understandable without color. A deeper “What is Expected Value (EV)?” link leads to the Learn article.

## Interface Contract

`MetricPresentation` receives materialized signed EV dollars, signed EV basis points, Pack Price, Gross EV, currency, availability status, and public reason codes. It validates formula consistency in development/tests and returns formatted display strings, semantic state, accessible label, and glossary reference; it never recomputes a competing sortable value at runtime.

The contract is shared by Overview, All Packs, pack inspector, and Learn examples. It contains presentation behavior only and never recalculates probability distributions.

## Acceptance Criteria

### Formula and State Evidence

- [x] A pipeline return of 107.50% displays as `+7.50%`, while 92.50% displays as `-7.50%`.
- [x] EV $ equals Gross EV minus Pack Price with integer-minor-unit arithmetic.
- [x] Positive, neutral, negative, and unavailable examples produce distinct text and accessible labels.
- [x] Provider-reported EV never replaces an unavailable PackScout estimate.
- [x] Net EV, fee, shipping, and individual-outcome claims are absent.

### Glossary and Consistency Evidence

- [x] All twelve comparison fields have enabled-by-default definitions.
- [x] Hints are reachable by pointer and keyboard and link EV learning to the approved guide.
- [x] Currency and percent formatting matches across all public surfaces.
- [x] Missing metric values show `Unavailable` plus stable public reason copy.
- [x] Both themes preserve semantic contrast without relying on color alone.

## Build Status

- Implemented: one shared `MetricPresentation` and metric vocabulary for signed integer money/basis points, positive/neutral/negative/unavailable semantics, bounded public reason copy, all twelve glossary definitions, and the Expected Value guide link.
- Verified: focused metric/vocabulary/glossary behavior tests cover exact signs, formula consistency, source-value non-substitution, pointer and keyboard hints, one-open-surface behavior, dismissal, and narrow/zoom containment; the shared components render in both themes.
- Blocked: the presentation slice is locally complete, but its required live `repack-dashboard/003` data dependency is blocked and no activated cloud snapshot has supplied authoritative production values.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-004, repack-dashboard/ux-005
- Alignment: implemented the materialized-value-only presentation contract, semantic states, shared glossary copy, theme parity, and EV education without recalculating or substituting source estimates.
- Divergences: none in the presentation layer; status remains blocked solely because the upstream public-read/live-data contract is not complete.
- Verification: frontend metric, vocabulary, glossary, Learn, typecheck, lint, build, and both-theme browser checks recorded green.
