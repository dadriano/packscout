# UX Spec: Learn and Metric Education

**ID:** repack-dashboard/ux-004
**Related tasks:** repack-dashboard/004, repack-dashboard/005, repack-dashboard/009, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on UX specs:** repack-dashboard/ux-001
**Spec status:** draft

## Start Here

Open `/learn`, scan the four source-backed summaries, open each complete article, then follow an EV glossary link to the Expected Value article and back to Dashboard.

## Purpose

Help a buyer understand repacks, expected value, practical buyer red flags, and how PackScout sources and standardizes data before using a vendor action.

## User Goals and Success Criteria

### Reader goals

- Understand how PackScout uses platform-provided data and where its methodology is limited.
- Learn what a repack is without prior marketplace knowledge.
- Understand EV as a probability-weighted long-run average, including variance and repack-specific limitations.
- Recognize all eight source-backed red flags and complete the five-minute pre-purchase review.
- Return to the relevant Dashboard surface with shell and theme context intact.

### Success signals

- Learn exposes exactly four full articles in the approved order.
- Every index summary links to its complete article.
- EV-related education includes a visible financial disclaimer.
- Unknown article slugs return not-found inside the shared shell.
- Prose, formulas, lists, and the worked table remain complete and readable at desktop and narrow widths.

## Current UX Context

### Confirmed

- Learn has no CMS; the content registry is version-controlled and contains exactly four records.
- Search remains a catalog search and never returns Learn articles.
- The four card titles are `PackScout Methodology`, `What Is a Repack?`, `What Is EV (Expected Value)?`, and `Repack Red Flags`.
- The user-supplied DOCX articles control full-article prose and material examples for this revision.
- Learn uses the same PackScout header, theme, focus treatment, and public navigation as Dashboard.

### Implementation guidance

- Use an editorial reading rhythm within the app shell rather than reproducing the dense Dashboard grid.
- Feature the methodology summary, then present the other three summaries as equal-priority article cards.
- Keep index copy condensed; the descriptive link must always lead to the complete article.
- Render source prose as typed semantic blocks rather than HTML strings or remote content.

## Information Architecture and Navigation

### Content registry

| Order | Slug | Card title | Full title |
|---|---|---|---|
| 1 | `packscout-methodology` | PackScout Methodology | PackScout Methodology |
| 2 | `what-is-a-repack` | What Is a Repack? | What Is a Repack? |
| 3 | `expected-value` | What Is EV (Expected Value)? | What Is EV (Expected Value): A Complete Guide, With a Deep Dive Into Repack EV |
| 4 | `repack-red-flags` | Repack Red Flags | Repack Red Flags: How to Spot a Scam or Rigged Product Before You Buy |

### Learn index

1. The page heading introduces Learn as practical repack guidance.
2. A featured methodology summary shows title, reading time, concise source-backed copy, and `Read the full methodology`.
3. Each remaining card shows title, summary, reading time, and `Read full article: {title}`.
4. Cards remain in the approved order at every width.
5. No newsletter, account, personalization, or vendor promotion interrupts the list.
6. The global catalog search remains available but visually secondary to article browsing.

### Article navigation

- Begin with a visible `Back to Learn` link before the article title.
- End with one context-relevant Dashboard link rather than a generic call to action.
- EV glossary help links directly to `/learn/expected-value`.
- Methodology and EV return to Overview; repack and red-flags return to All Repacks.
- Preserve theme and global navigation across every route transition.

## Interaction Model

### Glossary help

1. A user focuses, activates, or hovers a column's glossary hint.
2. A concise definition appears without requiring navigation.
3. EV-related definitions include a descriptive `Learn how EV is estimated` link.
4. Escape closes a dismissible hint and returns focus to its trigger.
5. Opening the article follows normal link behavior and leaves browser history intact.

### Article reading

- Internal links are standard links, not buttons.
- Formulas remain selectable, wrapping text rather than images.
- Bulleted and numbered source material uses semantic lists.
- The five-column EV example uses a captioned table with row and column headers.
- At narrow widths, the EV table scrolls inside a labelled, keyboard-focusable region without widening the page.
- Browser back returns to the prior Dashboard or Learn context.

## Layout and Responsive Behavior

### Index

- Use a comfortable reading-width heading area followed by one featured methodology band and three article cards.
- Allow the three cards to share a row only while long titles and summaries remain readable.
- Stack cards in source order at narrow widths.
- Keep reading time and link placement consistent across cards.
- Avoid KPI-style numerical hierarchy on educational content.

### Articles

- Use one centered reading column with a clear H1 → H2 → H3 hierarchy.
- Separate the summary from the full source introduction.
- Keep paragraphs scannable without dropping source caveats or examples.
- Place the shared EV disclaimer near the EV article header.
- Let formulas and table examples use full article width without expanding the page.
- Keep return navigation visible before the main heading on narrow screens.

## States and Feedback

### Content states

- `index_loaded`: exactly four complete guide records render.
- `article_loaded`: one known slug renders its complete ordered semantic blocks.
- `article_not_found`: shared shell plus not-found heading and Back to Learn action.
- `content_error`: concise recovery message; Dashboard and other Learn links remain usable.
- `link_focus`: visible focus persists on glossary, article, table-scroll, and return links.

### Glossary states

- Closed, focus-open, pointer-open, and dismissed states share the same definition content.
- The hint remains associated with its column trigger.
- Only one transient glossary surface is open at a time.
- Definitions remain available when hover is unavailable.

## Accessibility

- Use one page-level heading and do not skip levels in the full article body.
- Explain expected value (EV) at first use and do not rely on the abbreviation alone.
- Give every summary link meaningful destination text.
- Keep formulas readable as text and do not encode relationships only in a diagram.
- Use real list semantics for the repack formats, buyer checks, data sources, coin-flip inputs, and red-flag checklist.
- Give the worked table a caption, column headers, row headers, and contained focus-visible overflow.
- Announce article not-found as a page outcome, not as a transient alert.

## Visual Design Direction

- Reuse the approved light/dark palette, violet interaction accent, fine borders, and application typography.
- Keep Learn visually part of the application rather than a separate marketing site.
- Use quieter surfaces and more whitespace than Dashboard.
- Favor an unframed featured methodology band and reserve cards for the repeated article summaries.
- Use callout borders and mono labels for formulas and caveats rather than heavy tinted panels.

## Content and Microcopy

### Guide summaries

- Summaries must accurately condense their controlling DOCX article rather than introduce new product claims.
- `Read the full methodology` opens `/learn/packscout-methodology`.
- `Read full article: {title}` opens the corresponding article route.
- Reading time format: `{n} min read`.

### Source-backed trust copy

- PackScout standardizes platform-provided data and updates it as the underlying data changes.
- At launch, PackScout does not independently value the cards or collectibles inside a repack.
- Expected value is an average across possible outcomes, not a prediction for one pack.
- `Unavailable` does not mean zero; it means the necessary data is unavailable.
- Opening a repack involves risk and can result in financial loss.

## Design System and Component Notes

### Components

- `LearnIndex`: one featured methodology summary plus three linked article summaries.
- `ArticleLayout`: return link, full title, metadata, summary, source introduction, ordered semantic blocks, disclaimer, and related Dashboard link.
- `ArticleBlock`: typed paragraph, subheading, list, formula, or table renderer.
- `GlossaryHint`: shared with Dashboard table and metric help.

### Content ownership

- Keep one four-record registry as the public content surface.
- Split full prose into one pure-data module per article to keep ownership reviewable.
- Do not add remote content loading, HTML strings, authoring UI, account state, or newsletter state.
- Keep article examples independent from reactive catalog data.

## Cross-Spec and Technical Dependencies

- `ux-001` supplies the shell, routes, theme, catalog search, and not-found frame.
- `ux-002` supplies glossary triggers and Dashboard destinations.
- `ux-003` links inspector metric help to the EV article.
- `ux-005` owns narrow reading behavior, focus, contrast, content errors, and browser verification.
- Task `005` remains the source for Dashboard calculation contracts; this spec governs the source-backed Learn presentation.

## QA and Review Checklist

### Registry and navigation

- [ ] Exactly four articles render in the approved order with stable slugs.
- [ ] Every summary links to the corresponding complete article.
- [ ] EV glossary help reaches the Expected Value article.
- [ ] Article links back to Dashboard and Learn preserve normal browser history.
- [ ] Unknown slugs show not-found inside the shared shell.

### Trust and accessibility

- [ ] All material DOCX headings, paragraphs, lists, formulas, and table values are present.
- [ ] EV content distinguishes long-run estimates from individual outcomes.
- [ ] Red-flag content includes all eight checks and its pattern-not-proof caveat.
- [ ] Heading, link, list, formula, table, and tooltip semantics work by keyboard.
- [ ] No CMS, account, newsletter, personalization, or vendor-promotion prompt appears.

## Open Questions and Risks

No product questions remain for this slice.

### Risks to verify

- Methodology wording and Dashboard calculation vocabulary can drift because they have different owners.
- Long source titles and summaries can become cramped at intermediate widths.
- The five-column worked table can cause page-level overflow if its scroll containment fails.
- Financial caveats can become visually detached from examples on narrow screens.

## Handoff Notes

1. Build the typed four-record registry and stable route outcomes.
2. Render one featured summary and three linked article summaries.
3. Render all full source blocks, including formulas and the worked table.
4. Keep the EV glossary deep link stable.
5. Review both themes at desktop and mobile widths, including every article and an unknown slug.
