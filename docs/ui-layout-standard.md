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

## Admin visual template

The admin console renders on one template. `apps/admin/src/theme.css` is the only
place palette, typography, elevation, and status values are declared; every other
admin stylesheet consumes those tokens.

- Typography: `--admin-font-sans` (Inter first) for all copy and headings, `--admin-font-mono` for identifiers, cursors, and codes. There is no display face.
- Surfaces: warm neutral operational greys — `--admin-bg*`, `--admin-card-bg*`, `--admin-surface-sheen`, `--admin-surface-veil` — with `--admin-shadow*` for elevation and rounded card corners.
- Text hierarchy: `--admin-text`, `--admin-text-secondary`, `--admin-text-muted`, `--admin-text-faint`, `--admin-text-placeholder`. Prefer `--admin-text-muted` over `--admin-text-faint` for small labels, so contrast stays readable.
- Borders and inputs: `--admin-border*` weights plus `--admin-input-bg` and `--admin-input-border`.
- Status families: `--admin-primary*` (blue), `--admin-success*`, `--admin-warning*`, `--admin-danger*`, and `--admin-neutral*`, each with a surface tint and a text shade for badges, banners, and validation states.

Both themes express the same token names. Light is the canonical rendering on
`:root`; dark restates the family under `:root[data-theme="dark"]`, driven by the
top-bar theme toggle. Never branch on the theme in a component — restate a token.

Shared classes carry the template and are the extension surface for new pages:

- Shell: `.admin-layout`, `.admin-sidebar` with titled `.admin-nav-section` groups, `.admin-topbar`, `.admin-main`.
- Page frame: `.admin-page`, `.admin-page-header`, `.admin-eyebrow`, `.admin-section-heading`.
- Content: `.admin-ledger` and feature ledger/table surfaces, `.admin-metrics`, `.admin-status` badges, `.admin-empty-state`.
- Interaction: `.admin-button` variants, `.admin-icon-button`, `.admin-field`, `.admin-inline-error`, `.admin-dialog*`, `.admin-toast*`.

Focus stays deliberately loud: a 3px `--admin-primary` outline with offset on every
`:focus-visible` control. Do not trade it for a soft inset ring.

A new admin page composes these classes and tokens. If it needs something the
template lacks, extend the shared stylesheet — do not introduce a second palette,
a local font stack, or a hardcoded colour.

## Handoff checklist

- [ ] Existing primitives and tokens were used where practical.
- [ ] Reachable states are represented.
- [ ] Keyboard, focus, labeling, and contrast are correct.
- [ ] Text fits at supported widths with no horizontal overflow.
- [ ] Motion has a reduced-motion behavior.
- [ ] Responsive or visually complex changes received a browser smoke pass.
