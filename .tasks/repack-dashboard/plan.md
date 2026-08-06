# Repack Dashboard Base

Status: draft — planning only, not yet approved for implementation
Owner: product build

Packscout's first product surface: a public comparison table for digital repacks
("the real odds behind every pack"). Buyers currently reconcile pricing, odds,
and chase data across many platforms by hand; the dashboard answers "where is
the best current opportunity" in one place.

Implementation starts only when the product decision is approved and the
maintainer explicitly asks for it. The authoritative V1 behavior reference is
the MVP Developer Handoff (Dashboard + Learn functional contract); where this
plan and that handoff disagree, the handoff wins.

## V1 base scope (first implementation slice, when approved)

- Public, desktop-first and mobile-usable comparison table on the frontend home
  route with the confirmed columns: Platform, Category, Pack, Pack Price, EV $,
  EV %, Buyback %, Gross EV, Top Chase, Top Chase Value, Promo Code, Pack Link.
- Filters: multiple platforms, multiple categories, and pack price between $10
  and $12,000. Sorting on useful metrics with EV $ high-to-low as the default.
  Pagination.
- Tooltip glossary for every column, enabled by default.
- Public promo codes are copyable. Pack Links open the platform listing and
  preserve affiliate/source tracking parameters.
- Semantic positive/negative/neutral EV presentation that never relies on color
  alone. Visual system: black and white surfaces with one blue accent.
- Learn section with exactly three launch articles: "What is a repack?",
  "What is Expected Value (EV)?", and "Repack Red Flags."

## Beyond the base slice

- Accounts (email/password), proprietary promo codes, and the single saved
  filter preset — blocked on the repository's deliberate auth deferral.
- Real data ingestion. The base would ship a typed fixture catalog behind a
  server seam (`apps/frontend/lib/repacks.server.ts`) so the query contract, UI, and
  tests are real while persistence and ingestion decisions land later.
- Terms of Service and Privacy Policy pages (launch requirement, pending
  counsel review), mailing-list capture beyond an outbound newsletter link.
- Net EV, Median Outcome, Chance of Loss, and Outlier-Adjusted EV are product
  non-goals to protect platform relationships, not omissions.

## Constraints

- Partner-friendly presentation: platforms are beneficiaries of referral
  traffic, not targets of an adversarial rating system.
- Card imagery only from a platform's own listing or feed data; the base ships
  no third-party images.
- Money is handled in integer cents inside the domain module; formatting is a
  display concern.

## Open questions for the handoff review

- Are Floor/Minimum Return, EV sample size ("n="), and Top Chase thumbnails
  accepted into the confirmed V1 column set?
- What is the backend policy for generating promo codes and Pack Links and
  attributing conversions?
- Which side owns repack data collection (in-house indexer versus upstream
  feeds) and on what cadence does EV recalculate?
