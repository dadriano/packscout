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

### Class vocabulary

`apps/admin/src/index.css` carries the shared class vocabulary. It matches the
approved reference admin template name for name, so markup written against that
template renders here without renaming. Build new pages from these classes:

- Shell: `.admin-layout`, `.admin-sidebar` with `.admin-sidebar__section` → `.admin-sidebar__heading` + `.admin-sidebar__list` → `.admin-sidebar__link`, the `.admin-brand-lockup` / `.admin-brand-mark` / `.admin-brand-eyebrow` / `.admin-brand-title` lockup, `.admin-sidebar__footer` with `.admin-version-label` and `.admin-platform-notice`, `.admin-header` with `.admin-header__start` / `.admin-header__summary` / `.admin-header__end`, `.admin-main` → `.admin-main__inner` → `.admin-main__content`.
- Navigation state: `.admin-breadcrumbs` with `.admin-breadcrumbs__crumb`, `__separator`, `__link`, and `__current`. The trail is route-driven — add a destination to `apps/admin/src/routes/admin-routes.ts` and the sidebar, the document title, and the breadcrumbs all pick it up. Never add a second per-page label table.
- Page frame: `.admin-page`, `.admin-page-header`, `.admin-page-title`, `.admin-page-copy`, `.admin-page-actions`, `.admin-kicker`, `.admin-back-link`.
- Surfaces: `.admin-surface` is the card (border, radius, gradient, shadow); pair it with `.admin-panel` or `.admin-form-card` for padding. Compose with `.admin-stack` / `.admin-stack-lg`, `.admin-section-header` → `.admin-section-title` + `.admin-section-copy`, and `.admin-detail-header` / `.admin-detail-metadata`.
- Layout grids: `.admin-overview-grid` for metric tiles, `.admin-split-grid` for a primary/secondary column pair, `.admin-stat-grid` / `.admin-stat-card`, `.admin-kv-grid` / `.admin-kv-item`.
- Tables: `.admin-table-wrap` → `.admin-data-table` with `.admin-data-table__row`, `__actions`, and the `--actions` cell modifiers, plus `.admin-table-toolbar`, `.admin-table-actions`, `.admin-collection-toolbar`, `.admin-table-empty`, `.admin-table-error`, and `.admin-skeleton-bar` for loading rows.
- Badges and messages: `.admin-pill` / `.admin-chip` with `-primary`, `-success`, `-warning`, `-danger`, `-neutral`; `.admin-note*` and `.admin-banner*` for inline advisories; `.admin-inline-code` and `.admin-code-block` for identifiers and payloads.
- Forms: `.admin-field` with `.admin-label`, `.admin-form-grid`, `.admin-form-actions`, `.admin-value` / `.admin-muted`, and `.admin-form-error` for validation. Confirmation dialogs use `.admin-confirm-error` and `.admin-confirm-hint`.
- Interaction: `.admin-button` with `-primary`, `-secondary`, `-ghost`, `-danger`, `-warning`, and the `-sm` size; `.admin-icon-button`; `.admin-tabs` / `.admin-tab`.
- Overlays and states: `.admin-dialog-shell` → `.admin-dialog-backdrop` + `.admin-dialog-panel` (`--sm`, `--md`, `--full`) with `.admin-dialog-header` → `.admin-dialog-titles` → `.admin-dialog-title` + `.admin-dialog-description`, `.admin-dialog-body`, `.admin-dialog-footer`; `.admin-toast*` with `__message` and `__dismiss`; `.admin-empty-state`, `.admin-page-state`, `.admin-empty-panel`, `.admin-loading-block`, and `.admin-route-state` / `.admin-route-card` for pre-session routes.

Packscout adds a small number of classes the reference has no counterpart for:
`.admin-row-list` (a numbered evidence list used where the reference uses a data
table), `.admin-metric-card--inline`, `.admin-contract`, `.admin-section-count`,
`.admin-sign-out`, and `.admin-login-form`. They compose with the vocabulary
above rather than replacing it. Feature stylesheets keep their own namespace
(`ops-`, `provider-`, `alerts-`, `product-users__`).

Focus stays deliberately loud: a 3px `--admin-primary` outline with offset on every
`:focus-visible` control. Do not trade it for a soft inset ring.

A new admin page composes these classes and tokens. If it needs something the
template lacks, extend the shared stylesheet — do not introduce a second palette,
a local font stack, or a hardcoded colour. When a class is renamed, delete the
old rule in the same change; never leave both names live.

## Handoff checklist

- [ ] Existing primitives and tokens were used where practical.
- [ ] Reachable states are represented.
- [ ] Keyboard, focus, labeling, and contrast are correct.
- [ ] Text fits at supported widths with no horizontal overflow.
- [ ] Motion has a reduced-motion behavior.
- [ ] Responsive or visually complex changes received a browser smoke pass.
