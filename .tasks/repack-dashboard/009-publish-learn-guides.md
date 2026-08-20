# Task: Publish the Learn Articles

**ID:** repack-dashboard/009
**Depends on:** repack-dashboard/004, repack-dashboard/005
**Blocks:** repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Estimated scope:** medium
**Estimated effort:** 2–4 days for one builder, including content and route verification
**Status:** blocked

## Start Here

Publish the Learn index with four source-backed articles. Every condensed index summary must link to its complete article, and EV glossary help must continue to open the EV article.

## Objective

Give buyers complete, readable explanations of repacks, expected value, buyer red flags, and PackScout's data methodology before they follow a vendor listing.

## Context

Learn uses four version-controlled articles and no content-management system. The user-supplied DOCX articles are the controlling editorial sources for this revision. Learn shares the public PackScout shell and theme. Catalog search remains limited to repacks, vendors, and categories; it does not index articles.

## Requirements

### Learn Index

- Feature `PackScout Methodology`, followed by `What Is a Repack?`, `What Is EV (Expected Value)?`, and `Repack Red Flags`.
- Give each article an accurate summary, reviewed reading-time estimate, and descriptive link to the complete article.
- Keep article order fixed in the sequence above.
- Use the Dashboard/Learn header navigation and shared theme.
- Avoid account, newsletter, personalization, or vendor-promotion prompts.

### Full Article Content

- `PackScout Methodology` explains platform-provided data, standardization, Gross EV, buyback, price, inventory, odds, chases, pulls, dynamic data, unavailable values, data sources, limitations, financial caveats, and responsible play.
- `What Is a Repack?` retains the source article's definition, history, seller landscape, curation, popularity, controversy, common formats, buyer checks, and conclusion.
- `What Is EV (Expected Value)?` retains the general and net-EV formulas, coin-flip, roulette, insurance, poker, variance, repack-specific formula, worked tier table, input limitations, buyer uses, and conclusion.
- `Repack Red Flags` retains all eight source warning signs, the positive description of a trustworthy operator, the eight-item pre-purchase checklist, and its conclusion.
- Preserve source caveats that EV is a long-run average rather than an individual-outcome prediction and that repack purchases can result in financial loss.
- Keep the visible shared EV disclaimer near EV-related article content.

### Navigation and References

- Use `/learn/packscout-methodology`, `/learn/what-is-a-repack`, `/learn/expected-value`, and `/learn/repack-red-flags` as the four stable article addresses.
- Link EV glossary help to `/learn/expected-value`.
- Link methodology and EV articles to `/`; link the repack and red-flags articles to `/packs` with descriptive destination copy.
- Preserve theme and header context while moving between Dashboard and Learn.
- Return not-found for any unrecognized article address.
- Provide a visible route back to the Learn index from every article.

### Content Accessibility

- Use one page-level heading followed by a logical article heading hierarchy.
- Explain abbreviations and specialized terms at first use.
- Render lists as semantic lists, formulas as readable text, and the worked EV data as a captioned table.
- Keep wide tables inside their own keyboard-focusable scroll region at narrow widths.
- Give meaningful text to every internal link.

## User-Facing Behavior

Users can scan four summaries, open every complete article, enter from an EV tooltip, move back to the index, and return to Dashboard. Unknown article links show not-found rather than a generic error.

## Interface Contract

The Learn content registry exposes exactly four records with stable slug, card title, full title, summary, reading time, introduction, ordered semantic sections, and a related Dashboard link. Full article prose is split into typed, version-controlled modules with no remote CMS dependency or HTML-string rendering.

## Acceptance Criteria

### Content and Navigation

- [ ] The Learn index exposes exactly four source-backed articles in the approved order.
- [ ] Every summary has a descriptive link to its complete article.
- [ ] Every article has a stable address, full title, reviewed reading time, index return link, and related Dashboard link.
- [ ] EV glossary links open the EV article.
- [ ] Unknown article addresses produce not-found.
- [ ] Catalog search continues to target repacks rather than Learn content.

### Trust and Accessibility

- [ ] All four full articles retain their controlling source sections and material examples.
- [ ] EV content distinguishes long-run averages from individual outcomes and includes a visible disclaimer.
- [ ] Red-flag guidance includes all eight checks and makes clear that one flag alone does not prove a scam.
- [ ] Heading hierarchy, lists, formulas, links, and the worked table remain accessible at desktop and mobile widths.
- [ ] No CMS, account, newsletter, personalization, or vendor-promotion dependency is introduced.

## Build Status

- Implemented: typed per-article modules, a four-record registry, linked index summaries, four stable article routes, semantic lists/formulas/table rendering, shared-shell status, glossary-to-EV links, article-to-Dashboard links, and shared-shell not-found behavior.
- Verification: pending focused content, route, type, lint, build, and desktop/mobile browser checks for this revision.
- Blocked: dependency task `005` remains blocked on the live public-read contract, so this locally complete slice cannot be marked done under the canonical dependency graph.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-004, repack-dashboard/ux-005
- Alignment: the revision keeps a local typed registry, stable routes, shared navigation, responsive article layout, source-backed financial caveats, and the no-CMS boundary.
- Intentional revision: the prior three-guide summaries are replaced by four complete DOCX-backed articles, and the methodology summary now opens its own full article.
