# Task: Deliver the Pack Inspector and Actions

**ID:** repack-dashboard/008
**Depends on:** repack-dashboard/005, repack-dashboard/006, repack-dashboard/007
**Blocks:** repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Estimated scope:** large
**Estimated effort:** 4–6 days for one builder, including clipboard and outbound-action verification
**Status:** blocked

## Start Here

Open the first Overview opportunity in the inspector and render its identity, PackScout metric summary, top chase, promo action, and Pack Link from one `PackDetail` record.

## Objective

Give buyers a focused, evidence-aware pack preview and safe partner actions without leaving their current catalog context.

## Context

The supplied comps use a persistent right-side inspector. V1 keeps that pattern for Overview and uses a bottom preview for the wider twelve-column All Packs table. Narrow screens use one accessible modal sheet for both views.

The comp’s bookmark and Net EV donut are removed. Their inputs and user state are outside V1. The inspector instead presents a non-compositional PackScout Estimated EV summary that does not imply fees, shipping, or guaranteed returns.

## Requirements

### Pack Identity

- Show the approved pack image or a neutral PackScout placeholder, pack name, platform display name/logo, category, availability, and Pack Price.
- Give imagery descriptive alt text derived from the public pack or chase name.
- Keep provider listing attribution visible and partner-friendly.
- Label sold-out status beside the pack identity.
- Omit internal IDs, provider diagnostics, and canonical provenance identifiers.

### Estimated Value Summary

- Show signed EV %, EV $, Gross EV, Pack Price, Buyback %, and calculation data-as-of time.
- Use the shared positive, neutral, negative, and unavailable presentation.
- Show coverage or limitation copy when the public estimate contract supplies it.
- Replace the comp’s donut and Net EV rows with a simple metric summary; do not depict these values as parts of one total.
- Link metric help to the Expected Value Learn article.

### Top Chase

- Show the selected top chase’s approved image, name, value, and currency.
- Show label/value without an image when the evidence has no related approved asset image.
- Show Top chase unavailable when no eligible chase exists.
- Keep the supported canonical representative chase value derived from provider evidence distinct from PackScout Gross EV.
- Preserve a stable layout across all three chase states.

### Promo and Pack Link

- Copy a public promo code on activation and announce success through an accessible status message.
- On clipboard failure, reveal/select the code for manual copy and announce the failure.
- Build the Pack Link from the approved listing URL while preserving unrelated existing parameters.
- Add each platform’s approved PackScout referral parameter exactly once and open the provider destination in a new tab.
- Disable the outbound action for sold-out packs and omit it when the listing URL is unapproved or absent.

### Selection Behavior

- Overview selection updates the persistent side inspector without moving the results scroll position.
- All Packs selection updates a bottom preview without changing the query or cursor.
- Narrow-screen selection opens one modal sheet, moves focus into it, and returns focus to the selected row on close.
- Reactive data updates preserve selection when the public pack remains available.
- Removed selection falls back to the first visible pack or closes when no result remains.

## User-Facing Behavior

Users select a row, inspect the pack’s current value evidence and chase, copy a promo code, then open the provider listing with tracking intact. The UI explains unavailable evidence and never presents Net EV or a bookmark.

## Interface Contract

The inspector consumes `PackDetail`, `SnapshotMetadata`, and the shared `MetricPresentation`. It emits `promo_copied` and `pack_link_opened` outcome events without a persistent user identifier. The outbound builder accepts only approved listing configuration and returns a safe URL or an unavailable reason.

## Acceptance Criteria

### Inspector Evidence

- [x] Overview and All Packs render the same selected pack facts in their respective inspector placements.
- [x] EV %, EV $, Gross EV, Pack Price, Buyback, and calculation time follow the shared metric contract.
- [x] Top chase supports image, text-only, and unavailable states without layout breakage.
- [x] Missing pack imagery uses the neutral approved placeholder with useful alt text.
- [x] Bookmark, Net EV, fees, shipping, cost, and compositional donut UI are absent.

### Action and Selection Evidence

- [ ] Promo copy announces success and offers manual copy after clipboard failure.
- [x] Pack Link preserves unrelated parameters and contains one approved PackScout referral parameter set.
- [x] Sold-out, absent, or unapproved listings cannot open an outbound destination.
- [ ] Inspector selection survives safe reactive updates and recovers when a pack disappears.
- [x] Narrow-screen open/close manages focus and restores it to the selected row.

## Build Status

- Implemented: one placement-neutral inspector rendered as Overview side panel, All Packs bottom preview, and narrow native-dialog sheet; shared metric/chase states; neutral image fallback; promo/manual-copy logic; and allowlisted outbound URL construction. Selected details now come from bounded detail arrays returned with the same Convex query result as each visible summary.
- Verified: inspector presentation tests cover calculation time, coverage, and all chase variants; action tests cover exact referral replacement, blocked destinations, and clipboard fallback. Desktop/mobile browser QA against the local Convex seed confirms noninitial-row selection, inspector replacement, narrow sheet focus containment, Escape close, and focus return.
- Blocked: tasks `003`, `006`, and `007` are not complete. No live approved platform configuration or reactive cloud snapshot exists, and real-browser clipboard failure/success plus reactive selection recovery have not been recorded.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-003, repack-dashboard/ux-005
- Alignment: the shared inspector follows the required content order, non-compositional EV summary, three chase states, approved-action-only boundary, side/bottom/sheet placements, and modal focus lifecycle.
- Divergences: action tests and local browser QA use the deterministic mock snapshot's non-production platform configuration; no live dual-approved listing configuration or reactive point query is claimed.
- Verification: metric/inspector/action and Convex row/detail coherence tests, frontend typecheck/lint/build, and desktop/mobile sheet browser checks recorded green; live clipboard and reactive-removal evidence remains open.
