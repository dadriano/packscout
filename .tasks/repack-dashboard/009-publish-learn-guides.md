# Task: Publish the Learn Guides

**ID:** repack-dashboard/009
**Depends on:** repack-dashboard/004, repack-dashboard/005
**Blocks:** repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Estimated scope:** medium
**Estimated effort:** 2–4 days for one builder, including content and route verification
**Status:** blocked

## Start Here

Publish the Learn index with the three approved article titles and open “What is Expected Value (EV)?” from both its card and an EV glossary link.

## Objective

Give first-time buyers a concise, trustworthy explanation of repacks, PackScout Estimated EV, and common red flags before they follow a provider link.

## Context

V1 has exactly three maintained guides and no content-management system. Learn shares the public PackScout shell and theme. Pack search remains limited to packs, platforms, and categories; it does not index articles.

## Requirements

### Learn Index

- List exactly “What is a repack?”, “What is Expected Value (EV)?”, and “Repack Red Flags.”
- Give each article a concise description, reading-time estimate, and clear link.
- Keep article order fixed in the sequence above.
- Use the Dashboard/Learn header navigation and shared theme.
- Avoid account, newsletter, or personalization prompts.

### Article Content

- “What is a repack?” explains price, randomized contents, chase items, buyback, and provider differences in plain language.
- “What is Expected Value (EV)?” explains Gross EV, EV $, signed EV %, coverage, limitations, and individual-outcome uncertainty.
- “Repack Red Flags” covers missing odds, unclear inventory, unsupported values, stale listings, and pressure-driven claims without attacking named partners.
- Keep “Estimated EV · Not financial advice.” visible in EV-related content.
- Distinguish provider-reported values from PackScout estimates.

### Navigation and References

- Use `/learn/what-is-a-repack`, `/learn/expected-value`, and `/learn/repack-red-flags` as the three stable article addresses.
- Link EV glossary help to the EV article and relevant article terms back to Dashboard destinations.
- Link the repack and red-flags articles to `/packs`; link the EV article to `/` with descriptive destination copy and no fabricated filters.

### Route Continuity

- Preserve theme and header context while moving between Dashboard and Learn.
- Return not-found for any unrecognized article address.
- Provide a visible route back to the Learn index from an article.

### Content Accessibility

- Use descriptive headings in a logical hierarchy.
- Explain abbreviations and specialized terms at first use.
- Keep paragraphs and examples scannable without sacrificing the financial caveats.
- Give meaningful text to every internal link.
- Use tables or callouts only when their reading order remains clear on narrow screens.

## User-Facing Behavior

Users can browse the three guides, enter from an EV tooltip, move back to the index, and return to Dashboard. Unknown article links show not-found rather than a generic error.

## Interface Contract

The Learn content registry exposes exactly three records with stable slug, title, description, reading time, ordered sections, and related Dashboard links. The registry is public, version-controlled content and contains no remote CMS dependency.

## Acceptance Criteria

### Content and Navigation

- [x] The Learn index lists exactly the three approved articles in the approved order.
- [x] Every article has a stable address, title, description, reading time, and index return link.
- [x] EV glossary links open the EV article and relevant article links return to Dashboard.
- [x] Unknown article addresses produce not-found.
- [x] Search continues to target packs rather than Learn content.

### Trust and Accessibility

- [x] EV content uses the same Gross EV, EV $, signed EV %, and unavailable vocabulary as Dashboard.
- [x] Articles distinguish long-run estimates from individual outcomes and include the disclaimer.
- [x] Red-flag guidance remains provider-neutral and evidence-focused.
- [x] Heading hierarchy, link names, tables, and callouts remain accessible at desktop and mobile widths.
- [x] No CMS, account, newsletter, or personalization dependency is introduced.

## Build Status

- Implemented: a typed, version-controlled three-guide registry; Learn index; all three stable article routes; shared-shell status; glossary-to-EV and article-to-Dashboard links; and shared-shell not-found behavior.
- Verified: content/route tests prove exact titles, order, slugs, shared metric vocabulary, provider-neutral guidance, and unknown-slug behavior; desktop/mobile browser review confirms readable article/index layouts and navigation.
- Blocked: dependency task `005` remains blocked on the live public-read contract, so this locally complete slice cannot be marked done under the canonical dependency graph.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-004, repack-dashboard/ux-005
- Alignment: implemented the exact local registry, routes, shared vocabulary, provider-neutral trust copy, navigation, responsive article layout, and no-CMS boundary as specified.
- Divergences: none in the Learn slice; task status remains blocked only because its metric-contract dependency is not complete.
- Verification: Learn content/routes, metric vocabulary, frontend typecheck/lint/build, and desktop/mobile browser navigation checks recorded green.
