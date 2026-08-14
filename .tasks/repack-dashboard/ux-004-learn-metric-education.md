# UX Spec: Learn and Metric Education

**ID:** repack-dashboard/ux-004
**Related tasks:** repack-dashboard/004, repack-dashboard/005, repack-dashboard/009, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on UX specs:** repack-dashboard/ux-001
**Spec status:** draft

## Start Here

Open `/learn`, place the three approved guides in their fixed order, then follow an EV glossary link to the Expected Value article and back to Dashboard.

## Purpose

Help a buyer understand repacks, PackScout Estimated EV, and evidence-based red flags before using a provider action.

## User Goals and Success Criteria

### Reader goals

- Learn what a repack is without prior marketplace knowledge.
- Distinguish Gross EV, EV $, signed EV %, buyback, and top chase.
- Understand that EV describes long-run estimates rather than one pack outcome.
- Recognize missing odds, unclear inventory, unsupported values, stale listings, and pressure claims.
- Return to the relevant Dashboard surface with shell and theme context intact.

### Success signals

- Learn exposes exactly three guides in the approved order.
- Dashboard glossary wording and article wording do not conflict.
- EV-related education includes the visible financial disclaimer.
- Unknown article slugs return not-found inside the shared shell.
- Content remains scannable and complete at desktop and narrow widths.

## Current UX Context

### Confirmed

- V1 has no CMS; the content registry is version-controlled and contains exactly three records.
- Search remains a catalog search and never returns Learn articles.
- The three titles are fixed: `What is a repack?`, `What is Expected Value (EV)?`, and `Repack Red Flags`.
- Learn uses the same PackScout header, theme, focus treatment, and public navigation as Dashboard.
- Guidance remains provider-neutral and does not attack named partners.

### Implementation guidance

- Use editorial content rhythm within the app shell rather than reproducing the dense Dashboard grid.
- Keep cards limited to the three index entries; article body sections should read as a document.
- Use examples and callouts only when they clarify the shared metric model.
- Prefer direct language and short sections over marketing copy.

## Information Architecture and Navigation

### Content registry

| Order | Slug | Title |
|---|---|---|
| 1 | `what-is-a-repack` | What is a repack? |
| 2 | `expected-value` | What is Expected Value (EV)? |
| 3 | `repack-red-flags` | Repack Red Flags |

### Learn index

1. Page heading introduces Learn as practical repack guidance.
2. Each guide shows title, concise description, reading-time estimate, and descriptive link.
3. Cards remain in the approved order at every width.
4. No newsletter, account, personalization, or provider promotion interrupts the list.
5. The global catalog search remains available but visually secondary to article browsing.

### Article navigation

- Begin with a visible `Back to Learn` link before the article title.
- End with one context-relevant Dashboard link rather than a generic call to action.
- EV glossary help links directly to `/learn/expected-value`.
- Relevant article terms may link to Overview or All Packs with descriptive text.
- Preserve theme and global navigation across every route transition.

## Interaction Model

### Glossary help

1. A user focuses, activates, or hovers a column’s glossary hint.
2. A concise definition appears without requiring navigation.
3. EV-related definitions include a descriptive `Learn how PackScout estimates EV` link.
4. Escape closes a dismissible hint and returns focus to its trigger.
5. Opening the article follows normal link behavior and leaves browser history intact.

### Article reading

- Internal links are standard links, not buttons.
- In-page examples never use live provider data or imply current availability.
- Tables collapse or scroll within their own region when they cannot reflow.
- Callouts enter the normal reading order and do not depend on color or iconography.
- Browser back returns to the prior Dashboard or Learn context.

## Layout and Responsive Behavior

### Index

- Use a comfortable reading-width heading area followed by three equal-priority guide cards.
- Allow cards to share a row only while titles and descriptions remain readable.
- Keep reading time and link placement consistent across cards.
- Avoid KPI-style numerical hierarchy on educational content.

### Articles

- Use one centered reading column with a clear heading hierarchy.
- Keep paragraphs short enough to scan while retaining caveats and examples.
- Place `Estimated EV · Not financial advice.` near EV content, not only in the global shell.
- Allow tables and formula examples to use full article width without expanding the page.
- Keep return navigation visible before the main heading on narrow screens.

## States and Feedback

### Content states

- `index_loaded`: exactly three complete guide records render.
- `article_loaded`: one known slug renders its ordered sections.
- `article_not_found`: shared shell plus not-found heading and Back to Learn action.
- `content_error`: concise recovery message; Dashboard and other Learn links remain usable.
- `link_focus`: visible focus persists on glossary, article, and return links.

### Glossary states

- Closed, focus-open, pointer-open, and dismissed states share the same definition content.
- The hint remains associated with its column trigger.
- Only one transient glossary surface is open at a time.
- Definitions remain available when hover is unavailable.

## Accessibility

- Use one page-level heading, then ordered article headings without skipped levels.
- Explain Expected Value (EV) at first use and do not rely on the abbreviation alone.
- Give every article link meaningful text that includes its destination topic.
- Keep formula examples readable in text and do not encode relationships only in diagrams.
- Announce article not-found as a page outcome, not as a transient alert.

### Glossary semantics

1. Give each hint trigger an accessible name containing the column name.
2. Associate the visible definition with the trigger.
3. Keep the Learn link in normal keyboard order.
4. Support Escape without closing unrelated page UI.
5. Return focus to the trigger after keyboard dismissal.

## Visual Design Direction

### Confirmed

- Reuse the final comps’ light/dark palette, violet interaction accent, fine borders, and clear typography.
- Keep Learn visually part of the application rather than a separate marketing site.
- Use semantic green/red only inside examples that also include signs and state words.
- Preserve the approved PackScout logo and header proportions.

### Implementation guidance

- Use quieter surfaces and more whitespace than the Dashboard while retaining the same base type system.
- Give guide cards distinct headings without ornamental illustrations that imply unsupported content.
- Use callout borders and labels instead of heavy tinted panels.
- Keep numerical examples tabular and aligned.

## Content and Microcopy

### Guide descriptions

- `What is a repack?` — `How randomized collectible packs, chase items, and buyback offers work.`
- `What is Expected Value (EV)?` — `How PackScout estimates long-run value and why one result can differ.`
- `Repack Red Flags` — `Evidence to check before opening or buying a pack.`
- Reading time format: `{n} min read`

### Shared metric vocabulary

- `Gross EV`: estimated value of contents before fees and shipping.
- `EV $`: Gross EV minus Pack Price.
- `EV %`: percentage Gross EV is above or below Pack Price.
- `Buyback %`: provider-supported buyback coverage relative to Pack Price, supplied directly or derived from documented provider terms.
- `Top Chase`: highest-valued eligible related collectible currently identified.

### Trust copy

- `Estimated EV · Not financial advice.`
- `EV is a long-run estimate. It does not predict the contents or outcome of one pack.`
- `Unavailable means PackScout does not have enough supported evidence to show the value.`
- `Provider-reported values and PackScout estimates are different sources.`

## Design System and Component Notes

### Components

- `LearnIndex`: ordered three-record registry renderer.
- `GuideCard`: title, description, reading time, and descriptive link.
- `ArticleLayout`: return link, title, metadata, ordered sections, and related Dashboard link.
- `GlossaryHint`: shared with Dashboard table and metric help.
- `EducationCallout`: labelled note, caution, or example with linear reading order.

### Content ownership

- Keep all three guides in one typed local registry.
- Reuse shared metric definitions rather than copying independent strings into tables and articles.
- Do not add remote content loading, authoring UI, account state, or newsletter state.
- Keep article examples independent from reactive catalog data.

## Cross-Spec and Technical Dependencies

- `ux-001` supplies the shell, routes, theme, catalog search, and not-found frame.
- `ux-002` supplies glossary triggers and Dashboard destinations.
- `ux-003` links inspector metric help to the EV article.
- `ux-005` owns narrow reading behavior, focus, contrast, content errors, and browser verification.
- Task `005` remains the source for formulas and the twelve comparison definitions.

## QA and Review Checklist

### Registry and navigation

- [ ] Exactly three guides render in the approved order with stable slugs.
- [ ] Every guide has title, description, reading time, and descriptive link.
- [ ] EV glossary help reaches the Expected Value article.
- [ ] Article links back to Dashboard and Learn preserve normal browser history.
- [ ] Unknown slugs show not-found inside the shared shell.

### Trust and accessibility

- [ ] Dashboard and Learn use identical metric definitions and signs.
- [ ] EV content distinguishes long-run estimates from individual outcomes.
- [ ] Red-flag content remains evidence-focused and provider-neutral.
- [ ] Heading, link, table, callout, and tooltip semantics work by keyboard.
- [ ] No CMS, account, newsletter, or personalization prompt appears.

## Open Questions and Risks

No product questions remain for this slice.

### Risks to verify

- Duplicated glossary and article copy can drift if builders create separate definition sources.
- Tooltips can become difficult to use at high zoom if positioned outside the viewport.
- Financial caveats can become visually detached from examples on narrow screens.

## Handoff Notes

1. Create the three-record content registry and route outcomes first.
2. Build the Learn index and one article layout before writing all article sections.
3. Connect shared glossary definitions and EV article links.
4. Review headings, examples, caveats, and return links at both required viewports.
5. Finish with unknown-slug, keyboard-tooltip, and both-theme browser checks.
