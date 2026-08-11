# UX Spec: States, Responsive Behavior, and Accessibility

**ID:** repack-dashboard/ux-005
**Related tasks:** repack-dashboard/001, repack-dashboard/002, repack-dashboard/003, repack-dashboard/004, repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/009, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on UX specs:** repack-dashboard/ux-001, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-004
**Spec status:** draft

## Start Here

Render the loaded Overview beside loading, missing-initial-snapshot, delayed, no-match, and field-unavailable variants, then complete the select-and-inspect flow at 390×844 by keyboard.

## Purpose

Keep every PackScout V1 surface truthful, recoverable, readable, and operable across data conditions, themes, widths, input methods, and motion preferences.

## User Goals and Success Criteria

### State goals

- Know whether data is loading, unavailable, delayed, empty, filtered to no matches, or missing one field.
- Keep valid accepted results when a replacement request fails.
- Recover with Retry or Clear filters without losing unrelated context.
- Never mistake missing evidence for zero or an empty value.
- Continue to Learn even when Dashboard data is unavailable.

### Access goals

- Complete every V1 flow by keyboard, pointer, or touch.
- Read and operate the experience at 1440×1000 and 390×844 in both themes.
- Understand status, EV meaning, and summary values without color, imagery, hover, or motion.
- Use increased text size and browser zoom without clipped controls or page-level overflow.
- Receive useful dynamic announcements without repeated noise.

## Current UX Context

### Confirmed

- The hashed 1536×1024 final light/dark comps in `docs/design-comps/packscout-frontend/` are desktop-dense; mobile behavior is defined by the approved tasks rather than by a separate visual comp.
- The last complete snapshot remains readable during delayed publication.
- A missing initial snapshot must not render sample packs, zero KPIs, or empty charts.
- Missing estimate, category, chase, image, promo, or listing data is expected and has explicit fallback behavior.
- Required review viewports are exact-comp 1536×1024 plus responsive 1440×1000 and 390×844 in light and dark themes.

### Implementation guidance

- Preserve stable geometry between loading and loaded states to reduce disorientation.
- Use one public state vocabulary across Overview, All Packs, inspector, and Learn.
- Keep recovery feedback close to the initiating control while preserving the accepted content beneath it.
- Prefer native semantics and predictable document order over visual-only interaction patterns.

## Information Architecture and Navigation

### State ownership

| State | Owning region | Retained context |
|---|---|---|
| Loading | Dashboard data regions | Shell, theme, navigation, disclaimer, Learn |
| Snapshot unavailable | Dashboard page | Shell, valid URL state, theme, Learn |
| Delayed | Header status | Last complete snapshot and all valid controls |
| No matches | Results region | Filters, search, sort, theme |
| Field unavailable | Owning cell/detail | Pack row, selection, other available fields |

### Recovery hierarchy

1. Preserve accepted data and interaction context whenever a safe complete snapshot exists.
2. Show local recovery beside the failed action when only one request failed.
3. Show page-level Retry only when no complete snapshot can render.
4. Use Clear filters for a valid no-match result.
5. Keep not-found separate from data availability and query validation.

## Interaction Model

### Replacement requests

1. A user submits search, filters, sort, pagination, Retry, or a reactive refresh occurs.
2. Keep the accepted result visible and mark only the initiating region busy.
3. Prevent duplicate activation of the same pending command.
4. On success, replace the coherent result and announce the outcome once.
5. On failure, retain accepted content, restore initiating focus, and show a stable application error message.

### Selection recovery

- Preserve the selected public pack when it remains eligible and visible.
- Select the first visible pack when the current one disappears.
- Close the inspector when no visible pack remains.
- In a narrow sheet, restore focus to the selected row or the results heading if that row disappeared.
- Never reset accepted filters solely because selection became invalid.

### Public query errors

- Treat invalid query input as a stable application outcome, independent of transport status.
- Explain that the catalog view could not be restored and provide Reset to catalog defaults.
- Do not partially apply valid fragments from an invalid URL.
- Do not expose malformed cursor contents, internal codes, stack traces, or tenant/provider details.

## Layout and Responsive Behavior

### Wide review at 1440×1000

- Preserve the comps’ results-and-inspector hierarchy for Overview.
- Preserve table-first hierarchy and bottom preview for All Packs.
- Keep four KPI cards on screen in both themes.
- Keep filter actions and freshness copy free from collisions.
- Ensure page-level width remains bounded even when the All Packs table overflows internally.

### Narrow review at 390×844

- Reflow the header, search, title, disclaimer, KPI cards, and filters into deliberate stacked regions.
- Keep Apply, Reset, Previous, Next, theme, and sheet close controls within reachable touch and keyboard order.
- Open selected detail in a modal sheet rather than inserting a long inspector between rows.
- Keep wide data tables inside a named horizontal scroll region.
- Stack Learn cards, article content, and current-catalog summaries without changing their reading order.

### Text and media resilience

- Reserve pack and chase image space; prevent repeated broken-image loading loops.
- Let long pack, provider, and category names wrap or truncate with an accessible full name.
- Keep controls and content usable at browser zoom and increased text size.
- Avoid fixed heights for text-bearing cards and state messages.
- Respect safe-area insets for the narrow inspector sheet.

## States and Feedback

### Page and snapshot states

| State | Presentation | Action |
|---|---|---|
| `loading` | Stable placeholders in KPI, result, summary, and inspector regions | None |
| `snapshot_unavailable` | `Pack data is temporarily unavailable.` with no invented values | `Retry` |
| `delayed` | Last complete data plus amber `Some data delayed` and update time | None |
| `empty_catalog` | `Pack data is not available yet.` with no pack actions | Learn remains available |
| `no_matches` | Constraint summary and no selected inspector | `Clear filters` |

### Field states

- Missing estimate: `Unavailable` plus approved evidence explanation.
- Missing category: `Uncategorized`.
- Missing pack image: neutral PackScout placeholder with pack-based alt text.
- Missing chase image: retain chase name/value in stable text-only layout.
- Missing promo or listing: omit its action entirely.

### Interaction feedback

- Apply shows local progress and retains accepted results.
- Pagination shows local progress and announces the new visible range.
- Promo copy announces success or manual fallback.
- Retry announces completion or retained failure without shifting focus.
- Reactive recovery replaces delayed status without reannouncing unchanged page content.

### Public reason copy

- Incomplete odds or inventory: `Estimate unavailable: supported evidence is incomplete.`
- Missing price: `Estimate unavailable: pack price is unavailable.`
- Unsupported currency: `Estimate unavailable: currency is not supported.`
- Missing buyback: `Buyback unavailable: supported coverage is not available.`
- Missing chase value: `Top chase value unavailable.`

### Public reason safety

- Do not render internal reason-code strings verbatim.

## Accessibility

### Keyboard and focus

1. Reach links, search, tabs, filters, sort headers, rows, hints, pagination, promo, Pack Link, theme, and sheet controls in logical order.
2. Show a visible focus indicator on every interactive control in both themes.
3. Move, contain, and restore focus for the narrow inspector sheet.
4. Support Escape for the sheet and dismissible glossary hints.
5. Return focus to the initiating control after recoverable errors.

### Semantics

- Use landmarks for header/navigation, main content, results, inspector, and footer content when present.
- Use real tables with associated headers and `aria-sort` for All Packs and opportunities.
- Use tablist/tab semantics for Overview and All Packs, and dialog semantics for the narrow sheet.
- Use status/live semantics for result, page, clipboard, loading, and recoverable-error outcomes.
- Expose current-catalog bar values as text rather than as unlabeled graphics.

### Visual access

- Meet readable contrast for text, borders, focus, controls, and semantic states in both themes.
- Pair EV color with sign and Positive, Neutral, Negative, or Unavailable meaning.
- Preserve meaning without imagery; use alt text only when an image carries content.
- Remove nonessential motion when `prefers-reduced-motion` is active.
- Do not use hover as the only path to glossary, full names, or status detail.

## Visual Design Direction

### State styling

- Use skeleton-like neutral blocks that match final content geometry without simulating real values.
- Use amber only for delayed-but-usable data, not for generic loading.
- Use muted text and a clear label for unavailable fields rather than low-contrast blanks.
- Keep error regions concise and visually connected to Retry or Reset.
- Preserve the same state hierarchy and content in both themes.

### Responsive styling

- Maintain the comps’ fine borders, restrained radii, and violet action emphasis.
- Reduce simultaneous columns before reducing readable type or control targets.
- Keep internal table overflow visibly separate from page overflow.
- Avoid viewport-scaled body text and fixed-height state containers.
- Use reduced-motion-safe transitions for sheets, themes, and result replacement.

## Content and Microcopy

### Recovery copy

- Initial unavailable: `Pack data is temporarily unavailable.`
- Initial action: `Retry`
- Delayed status: `Some data delayed · Updated {time}`
- Empty catalog: `Pack data is not available yet.`
- No matches: `No packs match these filters.`

### Query and action copy

- No-match action: `Clear filters`
- Invalid restored URL: `This catalog view could not be restored.`
- Invalid-state action: `Reset catalog`
- Retained failure: `Could not refresh. Showing your previous results.`
- Loading label where needed: `Updating results…`

## Design System and Component Notes

### Shared state components

- `StablePlaceholder`: shape variants for KPI, row, summary, image, and inspector.
- `PageState`: snapshot unavailable, empty catalog, not-found, and content error.
- `InlineRecovery`: retained-results failure and Retry behavior.
- `UnavailableValue`: label, public reason, and accessible association.
- `LiveFeedback`: bounded announcements for results, clipboard, pagination, and errors.

### Accessibility primitives

- `FocusReturn`: resilient trigger tracking for modal-sheet close.
- `ModalSheet`: labelled dialog, focus containment, Escape, and background inertness.
- `ScrollableTableRegion`: label, internal overflow, and keyboard visibility.
- `VisuallyHidden`: exact timestamps and supporting accessible names only where visible copy would duplicate meaning.
- Reuse native controls before adding custom keyboard behavior.

## Cross-Spec and Technical Dependencies

- `ux-001` supplies the persistent shell and public freshness region.
- `ux-002` supplies filter, result, table, pagination, and selection ownership.
- `ux-003` supplies inspector content, action states, and modal-sheet purpose.
- `ux-004` supplies Learn content and glossary behavior.
- Tasks `001`–`003` must produce sanitized, coherent application states; the UI must not infer state from raw provider or tenant diagnostics.

## QA and Review Checklist

### State coverage

- [ ] Loaded, loading, unavailable initial snapshot, delayed, empty catalog, and no matches are distinct.
- [ ] Missing fields never render as zero, blank, fake imagery, or placeholder actions.
- [ ] Failed replacement requests preserve accepted results and valid query state.
- [ ] Retry and Clear filters restore focus and announce one result.
- [ ] Public copy contains no provider diagnostics, tenant IDs, internal runs, or quarantine detail.

### Responsive and accessible coverage

- [ ] Exact-comp visual review passes at 1536×1024 and every V1 flow completes at 1440×1000 and 390×844 in both themes.
- [ ] Keyboard focus, table sort, tabs, glossary, sheet, and live feedback expose correct semantics.
- [ ] All Packs scrolls only inside its owned table region.
- [ ] Zoom, increased text, missing images, and long names do not clip controls or create page overflow.
- [ ] Reduced motion, contrast, console, hydration, and broken-image checks are recorded.

## Open Questions and Risks

No product questions remain for this slice.

### Risks to verify

- Stable placeholders can imply fake data if they resemble populated values too closely.
- Excessive live announcements can make reactive data unusable for screen-reader users.
- Focus restoration can fail when reactive updates remove the original row.
- Twelve-column table interaction can become undiscoverable on touch without a clear scroll affordance.
- Public state copy can leak operational detail if raw error strings bypass the approved mapping.

## Handoff Notes

1. Build the state vocabulary and approved public copy before wiring error objects to UI.
2. Create complete, partial, delayed, no-match, and unavailable fixture stories for every owning surface.
3. Verify desktop and narrow document order before adding modal-sheet animation.
4. Run keyboard, focus, zoom, contrast, reduced-motion, and internal-overflow reviews.
5. Record browser evidence for both required viewports and themes before launch validation.
