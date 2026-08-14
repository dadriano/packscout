# UX Spec: Pack Inspector and Partner Actions

**ID:** repack-dashboard/ux-003
**Related tasks:** repack-dashboard/002, repack-dashboard/003, repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on UX specs:** repack-dashboard/ux-001, repack-dashboard/ux-002
**Spec status:** draft

## Start Here

Select the first visible Overview opportunity and build its inspector from one `PackDetail`: identity, simple PackScout metric summary, top chase, optional promo, and optional Pack Link.

## Purpose

Give a buyer enough trustworthy detail to understand and open one pack while preserving the comparison context they came from.

## User Goals and Success Criteria

### Inspection goals

- Confirm the pack, provider, category, availability, image, and price.
- Understand Gross EV, EV $, signed EV %, buyback, and calculation time without a compositional chart.
- See the best eligible related chase and its supported canonical representative value from provider evidence.
- Understand why a metric or image is unavailable.
- Return to the same selected row and catalog position.

### Action goals

- Copy an approved public promo code with clear success or manual fallback.
- Open only an approved active listing in a new tab.
- Know that PackScout adds referral tracking without changing unrelated listing parameters.
- Never encounter a disabled-looking placeholder action for data that was never configured.
- Complete actions even if anonymous telemetry fails.

## Current UX Context

### Confirmed

- Overview uses a persistent right inspector; All Packs uses a bottom preview; narrow screens use one modal sheet for both.
- The final comps’ pack identity, provider attribution, metric density, top-chase area, promo action, and full-width Open Pack action guide hierarchy.
- The comps’ bookmark, EV donut, Net EV, fees, shipping, and cost rows are outside V1 and must not appear.
- PackScout Estimated EV and the supported canonical representative top-chase value from provider evidence remain distinct.
- Promo and Pack Link actions appear only when approved public configuration exists.

### Implementation guidance

- Replace the donut with a plain metric group that cannot be read as parts summing to a total.
- Keep action hierarchy partner-friendly: evidence first, optional promo second, outbound action last.
- Use the same content order in side, bottom, and sheet placements so users do not relearn the inspector.
- Show limitation details progressively without hiding the primary comparison metrics.

## Information Architecture and Navigation

### Inspector order

1. Pack identity shows image, pack name, provider display name/logo, category, availability, and Pack Price.
2. PackScout Estimated EV shows signed EV %, EV $, Gross EV, buyback, and data-as-of context.
3. Evidence guidance shows coverage or a concise public limitation when supplied.
4. Top Chase shows image when approved, name, supported canonical representative value, and unavailable state.
5. Partner actions show Promo and Open Pack only when eligible.

### Context preservation

- Overview selection changes only the side inspector.
- All Packs selection changes only the preview below the table.
- Neither desktop placement changes route, filters, cursor, sort, or table scroll position.
- The narrow-screen sheet is transient UI, not a new route.
- Closing a sheet returns focus to the row that opened it.

## Interaction Model

### Selection and reactive updates

1. Select a visible row through its row-selection target.
2. Retain the results scroll position while the detail updates.
3. Preserve selection when a reactive snapshot still contains that public pack.
4. If selection disappears, choose the first visible pack.
5. If no pack remains, close the inspector or sheet and expose the owning empty state.

### Promo copy

1. Show `Copy promo` only when an approved public code exists.
2. Activation writes the exact displayed code to the clipboard.
3. Success changes local feedback and announces `Promo code copied` without moving focus.
4. Failure reveals the code in a selectable field and announces a manual-copy instruction.
5. A later pack selection clears the prior copy feedback.

### Open Pack

1. Show `Open pack` only for an approved listing URL.
2. Disable it for sold-out packs and explain the disabled reason.
3. Activation preserves unrelated query parameters and adds approved referral parameters exactly once.
4. Open the provider destination in a new tab with safe external-link behavior.
5. Attempt anonymous outcome telemetry without delaying or blocking navigation.

### Narrow-screen sheet

- Row selection opens the sheet and moves focus to its heading or close control.
- Focus remains inside while the sheet is open.
- Escape and the close control dismiss it.
- Background content is not interactive while open.
- Closing restores focus to the selected row even after internal actions.

## Layout and Responsive Behavior

### Overview side inspector

- Keep the inspector visible beside results at wide widths and align its top with the Dashboard workspace.
- Use internal sections and quiet dividers rather than separate nested cards.
- Reserve image space so selection changes do not move the metric summary.
- Keep the primary action near the end of the inspector and visible without overlapping content.
- Allow the page to scroll naturally when inspector content exceeds the viewport.

### All Packs bottom preview

- Place the preview outside the table’s horizontal scroll region.
- Reflow identity, metrics, chase, and actions across available width.
- Keep its selected-pack heading visible above detail columns.
- Do not make the bottom preview cover pagination or selected rows.
- Keep content order identical to the side inspector.

### Narrow sheet

- Use a modal sheet sized to the viewport with a persistent close control and scrollable content body.
- Keep Promo and Open Pack reachable without sticky controls obscuring evidence.
- Stack metrics into compact labelled pairs.
- Preserve image aspect ratios and neutral fallback geometry.
- Respect device safe areas where applicable.

## States and Feedback

### Pack states

- `active`: approved Open Pack action may appear.
- `sold_out`: visible status; Open Pack is disabled and no referral navigation occurs.
- `removed`: selection falls back or closes according to visible results.
- `image_unavailable`: neutral PackScout placeholder preserves layout.
- `detail_failed`: retain summary context and offer a local Retry without clearing catalog state.

### Metric and chase states

- Estimated values show Positive, Neutral, Negative, or Unavailable using the shared presentation.
- Buyback unavailable is distinct from zero buyback.
- Top chase supports image, text-only, and unavailable variants.
- Limitation copy uses public language and never exposes internal reason codes or revision IDs.
- Calculation time and snapshot update time remain separately labelled.

### Action states

- Promo supports available, copied, clipboard-failed, and omitted states.
- Open Pack supports available, sold-out disabled, unapproved omitted, and absent omitted states.
- Action progress remains local to the activated control.
- Telemetry failure is silent to the buyer and cannot change the action result.

## Accessibility

- Give the inspector a labelled complementary-region role on desktop and dialog semantics in the narrow sheet.
- Derive useful image alt text from the public pack or chase name; mark purely decorative provider marks appropriately.
- Associate every value with a visible metric label and include currency in accessible output.
- Keep unavailable explanations adjacent and programmatically connected to their values.
- Use a polite live region for clipboard outcome only.

### Action semantics

1. `Copy promo` is a button because it performs a command.
2. `Open pack` is a link when a safe URL exists; sold-out presentation must communicate disabled behavior accessibly.
3. External-link text or accessible naming states that the provider opens in a new tab.
4. Row selection remains separate from both action focus targets.
5. Visible focus survives local success feedback and snapshot updates.

## Visual Design Direction

### Confirmed

- Follow the comps’ strong pack image, clear provider attribution, compact numerical hierarchy, top-chase block, and violet outbound action.
- Use violet for the primary action and promo accent, not for every metric.
- Use tabular numerals and aligned labels for the metric summary.
- Use fine dividers to separate identity, metrics, chase, and actions.
- Maintain matched light/dark content and hierarchy.

### Required departures from the comps

- Remove the bookmark icon.
- Remove the EV breakdown donut.
- Remove Net EV, fees and shipping, and cost rows.
- Do not imply that Gross EV, buyback, and price are additive parts.
- Do not show a provider listing amount without a clear metric label.

## Content and Microcopy

### Metric copy

- Section heading: `PackScout Estimated EV`
- Labels: `EV %`, `EV $`, `Gross EV`, `Pack price`, `Buyback`
- Time label: `Calculated {date}` or `Estimate as of {date}`
- Limitation link: `How this estimate works`
- Unavailable label: `Unavailable`

### Chase copy

- Section heading: `Top chase`
- Missing chase: `Top chase unavailable`

### Action copy

- Promo action: `Copy promo`
- Copy success: `Promo code copied`
- Manual fallback: `Copy the code manually`
- Outbound action: `Open pack`

### Partner context

- Attribution: `Offered by {platform}`
- New-tab hint: `Opens the provider listing in a new tab.`
- Sold-out reason: `This pack is sold out.`
- Missing listing: omit the action rather than showing `Coming soon`.

## Design System and Component Notes

### Components

- `PackInspector`: shared content composition independent of placement.
- `PackHero`: approved image, fallback, pack identity, provider attribution, and status.
- `EvMetricSummary`: non-compositional labelled metric group and limitation access.
- `TopChase`: image, text-only, and unavailable variants.
- `PartnerActions`: promo feedback and safe outbound action eligibility.

### Placement adapters

- `OverviewInspector` places shared content in the wide side region.
- `CatalogPreview` places shared content below All Packs.
- `PackInspectorSheet` adds modal focus and dismissal behavior.
- Placement adapters must not fork metric copy, action eligibility, or unavailable logic.

## Cross-Spec and Technical Dependencies

- `ux-002` owns row selection and accepted catalog context.
- `ux-004` owns Expected Value education reached from metric help.
- `ux-005` owns placeholder, detail failure, modal focus, and responsive verification.
- Task `002` must publish one deterministic primary pack image, top-chase detail, approved promo, and safe listing configuration.
- Task `005` supplies formatting and semantic states; the inspector does not recalculate EV distributions.

## QA and Review Checklist

### Detail content

- [ ] Side, bottom, and sheet placements render the same selected pack facts.
- [ ] Metric labels and signs match the shared EV contract.
- [ ] Top chase remains stable with image, text-only, and unavailable data.
- [ ] Missing pack imagery uses the approved neutral fallback and useful alt text.
- [ ] Bookmark, donut, Net EV, fees, shipping, and cost are absent.

### Actions and focus

- [ ] Clipboard success and manual fallback are announced without moving focus.
- [ ] Approved listing parameters are preserved and referral parameters appear once.
- [ ] Sold-out, absent, and unapproved listings cannot navigate.
- [ ] Telemetry failure does not block copy or navigation.
- [ ] Narrow-sheet focus enters, remains contained, and returns to the selected row.

## Open Questions and Risks

No product questions remain for this slice.

### Risks to verify

- Provider imagery can have inconsistent aspect ratios or fail after publication.
- Copy feedback can persist against the wrong pack if selection changes during the outcome.
- New-tab navigation can be blocked if telemetry or URL work occurs before the direct user activation.
- Reactive removal can invalidate the focus-return target on narrow screens.

## Handoff Notes

1. Build one placement-neutral inspector with static complete and partial `PackDetail` examples.
2. Add Overview and All Packs placement adapters without duplicating content logic.
3. Add Promo and Open Pack eligibility before their visual polish.
4. Add the narrow modal sheet and focus lifecycle.
5. Review complete, sold-out, missing-image, missing-chase, and unavailable-EV packs in both themes.
