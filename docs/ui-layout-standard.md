# Layout and UI System Standard

Status: canonical frontend and admin UI standard

Packscout UI should be clear, grounded, accessible, and predictable. The two apps may use different implementation styles while sharing the same interaction discipline.

## Layout

- Reuse existing primitives and tokens before creating local one-offs.
- Do not wrap every section in decorative cards; use full-width bands or unframed groups when structure is enough.
- Reserve cards for repeated items, dialogs, and genuinely framed tools.
- Avoid layout jumps, overlapping text, viewport-scaled body copy, and decorative elements that obscure content.
- Use stable responsive constraints such as `minmax`, `max-width`, and deliberate breakpoints.
- Keep dense operator screens compact without sacrificing scanability.

## Controls

- Buttons issue commands; links navigate.
- Use checkboxes or switches for binary settings, segmented controls for modes, inputs for values, menus for option sets, and tabs for parallel views.
- Icon-only controls require familiar symbols and accessible names; add tooltips when meaning is not obvious.
- Destructive actions require confirmation and a recovery story.

## States

Every touched workflow should consider loading, empty, error, validation, forbidden, success, dirty/unsaved, and destructive-confirmation states.

## Accessibility

- Keyboard navigation reaches every interactive control in a logical order.
- Focus indicators are visible.
- Controls have visible labels or accessible names.
- Field errors are associated with their controls.
- Dynamic updates use live semantics where needed and never rely on color alone.
- Contrast remains readable and motion respects `prefers-reduced-motion`.

## Styling

- Frontend prefers Tailwind utilities and semantic theme tokens.
- Admin prefers shared CSS custom properties, shell patterns, and reusable classes.
- Stable layout and appearance do not belong in repeated inline style objects.
- Create a reusable primitive only when at least two paths need the same behavior or an existing primitive has become overloaded.

## Handoff checklist

- [ ] Existing primitives and tokens were used where practical.
- [ ] Reachable states are represented.
- [ ] Keyboard, focus, labeling, and contrast are correct.
- [ ] Text fits at supported widths with no horizontal overflow.
- [ ] Motion has a reduced-motion behavior.
- [ ] Responsive or visually complex changes received a browser smoke pass.
