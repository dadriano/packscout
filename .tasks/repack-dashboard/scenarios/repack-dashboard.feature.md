# Feature: PackScout Repack Dashboard V1

Status: active build handoff — local and cloud-development Convex-backed mock frontend/read-model slices implemented; canonical publication and launch evidence blocked
Owner: product build

## Scenario: Repack heat remains hidden before launch

Given the public catalog may include a release-bound heat aggregate
When the buyer opens Dashboard, All Repacks, a repack inspector, or Learn
Then no Heat label, badge, detail, or educational copy is visible or exposed to assistive technology
And existing EV, catalog, selection, and action behavior remains available

Coverage: Automated source-contract, table-header, and Learn-content tests keep Heat disconnected from public compositions while its data contract and dormant implementation remain intact. Desktop and narrow browser coverage verifies Dashboard, All Repacks, the shared inspector, and Learn with mock Heat data present.

## Scenario: A buyer opens a coherent market overview

Given a complete public catalog snapshot
When the buyer opens Dashboard Overview without filters
Then four KPI cards, six EV-dollar-ranked opportunities, platform summaries, category summaries, and the first selected pack come from one coherent result
And sold-out, disabled, and unavailable-EV packs do not enter Top Opportunities

Coverage: Automated plus development-browser coverage — the deterministic internal Convex seed creates 9 packs, and `convex/publicCatalog.test.ts` plus seed tests prove one bundle with 8 active packs, 6 opportunities, and bounded aligned details. Overview presentation tests and desktop/mobile local browser QA prove summary/selection rendering; the functions deployed to `abundant-puffin-373` and HTTPS cloud-development browser smoke additionally prove server reads, visible Mock data provenance, search, and selection. An activated canonical snapshot and reactive delivery remain blocked.

## Scenario: The provider stream contract is adopted without a compatibility path

Given sanitized real catalog, pulls, and trades pages with documented cursor scope
When the pipeline imports, resumes, and replays those streams
Then each requested stream advances only its associated durable cursor under that documented scope
And catalog corrections create revisions while pulls and trades remain immutable and idempotent
And no launch-source runtime reads the superseded aggregate V1 contract

Coverage: Partial automated coverage — V2 record fixtures, identity/nullability, mutable-catalog versus immutable-event policy, lifecycle mapping, and currency evidence have focused tests; blocked on real page wrapper/path/auth/cursor evidence, runtime V1 removal, three durable cursors, crash recovery, and backfill/incremental proof.

## Scenario: Public snapshot activation is atomic and idempotent

Given a complete active snapshot and a staged replacement
When batches are retried or the replacement fails count or hash reconciliation
Then no partial replacement becomes public and the complete active snapshot remains readable
And replaying an identical complete publication creates no duplicate public records

Coverage: Blocked — strict `CatalogSnapshotV1` fixtures and active-snapshot read tests exist. The guarded internal development seed proves deterministic one-transaction creation plus idempotent `created`/`unchanged` replay locally and on `abundant-puffin-373`, and refuses canonical, conflicting, or partial state. It is not the PostgreSQL ledger/config authority, HMAC publisher, canonical cloud lifecycle, staged activation, reconciliation, or rollback implementation.

## Scenario: A buyer searches the full catalog

Given public packs across multiple platforms and categories
When the buyer searches by pack, platform, or category
Then All Packs returns relevance-ordered results in cursor pages of up to 25 rows
And clearing search restores the prior accepted metric sort

Coverage: Automated plus development-browser coverage — Convex relevance/cursor tests and frontend canonical URL-state/table tests prove the search behavior; desktop/mobile browser QA searches the 9-pack local Convex snapshot and updates selection from bounded row-aligned details. HTTPS browser smoke proves search and selection against the same mock snapshot on `abundant-puffin-373`, while reactive preload and live cursor evidence remain blocked.

## Scenario: A buyer filters and sorts All Packs

Given active and sold-out public packs between $10 and $12,000
When the buyer applies multiple platforms, multiple categories, a price range, and an approved metric sort
Then only matching rows appear with deterministic ordering and every enabled comparison field except prelaunch Heat
And refresh, back, and forward restore the accepted query state

Coverage: Automated plus development-browser coverage — Convex filter/facet/price/sort/cursor tests, URL restoration tests, enabled-column table tests, and desktop/mobile search/selection/internal-overflow browser evidence against the local seed are green. Cloud-development search and selection are also green; cloud pagination and reactive replacement evidence remain open.

## Scenario: Invalid public input fails safely

Given the public catalog read boundary
When a request includes an unknown sort, malformed cursor, excessive query, invalid facet, or inverted price range
Then it returns a stable `{ error, code: "INVALID_QUERY" }` application outcome
And no partial data, stack trace, tenant identifier, or provider diagnostic is exposed

Coverage: Automated local coverage — strict public input/result-union tests and `convex/publicCatalog.test.ts` reject malformed fragments and return stable sanitized application outcomes; no organization or provider selector is exposed.

## Scenario: PackScout EV remains explainable

Given a pack price of $100 and a pipeline gross-return percentage of 107.50%
When the dashboard presents PackScout Estimated EV
Then it displays signed EV % as +7.50% and EV $ as Gross EV minus Pack Price
And Positive, Neutral, Negative, and Unavailable states use text or sign semantics in addition to color

Coverage: Automated local coverage — metric-presentation tests prove exact signed basis points, integer-minor-unit consistency, semantic states, unavailable handling, all twelve glossary definitions, and keyboard/pointer glossary behavior; authoritative live snapshot values remain blocked upstream.

## Scenario: Missing evidence is not invented

Given a public pack lacks an estimate, category, chase, image, promo code, or listing URL
When it appears in All Packs or the inspector
Then each missing field uses its approved unavailable or fallback presentation
And no zero metric, fake image, placeholder action, Net EV, fee, or shipping value is rendered

Coverage: Automated local coverage — strict snapshot contracts, deterministic Convex mock records, public-state components, pack/chase presentation tests, and browser partial-state review prove non-invented fallbacks. `dataSource` is required as mock or canonical, mock data is visibly labeled, and public reads fail closed for mock snapshots in production; real publisher/config evidence remains blocked.

## Scenario: A buyer inspects a pack without losing context

Given a visible pack row
When the buyer selects it
Then Overview updates its side inspector, All Packs updates its bottom preview, and narrow screens open an accessible modal sheet
And closing the narrow-screen inspector returns focus to the selected row

Coverage: Automated plus browser coverage — one shared inspector powers side, bottom, and modal-sheet placements from the bounded details returned with each Convex result; desktop/mobile local noninitial-row selection proves inspector replacement, focus entry, containment, Escape close, and focus return, while cloud-development selection proves replacement through the HTTPS deployed read path. Reactive removal recovery against canonical Convex data remains open.

## Scenario: A buyer copies a public promo code

Given a pack with a platform-approved public promo code
When the buyer activates Copy Promo
Then clipboard success is announced accessibly
And clipboard failure reveals the code for manual copy without losing selection

Coverage: Partial automated coverage — promo helpers copy only the public code and produce a stable manual-fallback outcome without blocking telemetry; real-browser clipboard success/failure announcements and focus preservation still require recorded evidence.

## Scenario: A buyer opens a tracked Pack Link

Given an active pack with an approved listing URL containing existing parameters
When the buyer activates Open Pack
Then unrelated parameters remain and the approved PackScout referral parameters appear exactly once
And telemetry failure cannot block the new-tab navigation

Coverage: Automated local coverage — action tests preserve unrelated parameters, set each approved referral parameter once, block unsafe/sold-out inputs, and keep telemetry nonblocking; approved preproduction configuration and real outbound browser evidence remain open.

## Scenario: A sold-out pack cannot open a listing

Given a sold-out public pack with an otherwise approved listing URL
When a buyer inspects or selects that pack
Then sold-out status is visible and Open Pack is non-actionable
And no referral navigation or outbound telemetry outcome is emitted

Coverage: Automated local coverage — snapshot validation forbids sold-out Pack Links, All Packs tests suppress the action, and outbound helpers block sold-out navigation; live publication/config evidence remains open.

## Scenario: Anonymous telemetry remains bounded and private

Given a buyer searches, filters, copies a promo, or opens a pack
When PackScout records an approved product outcome
Then the event contains no persistent user, tenant, wallet, credential, or raw-search value
And retries deduplicate inside 24 hours while telemetry failure never blocks the buyer action

Coverage: Partial automated coverage — strict five-event client/route contracts reject identity/raw search/extra fields and transport failures are nonblocking; durable 24-hour dedupe, edge limiting, database storage/aggregation, 30-day/13-month retention, and audited access are not implemented.

## Scenario: Delayed publication remains truthful

Given the latest publication fails after a complete snapshot exists
When a buyer opens Dashboard
Then the last complete snapshot remains readable with “Some data delayed” and its last successful catalog-observation time
And recovery replaces delayed status without exposing internal provider details

Coverage: Partial automated coverage — Convex read tests return delayed metadata with the retained complete snapshot and frontend status/state components render sanitized delayed copy; publisher failure, metadata-only refresh, recovery, and previous-snapshot activation remain blocked.

## Scenario: Initial unavailability never invents data

Given no complete public snapshot has ever activated
When a buyer opens Dashboard
Then PackScout shows `Pack data is temporarily unavailable.` with Retry
And no KPI zero, sample pack, fake image, promo, or Pack Link is rendered while Learn remains available

Coverage: Automated local coverage — missing-snapshot query outcomes and page recovery components prove the exact Retry copy with no invented values while local Learn content remains available; public-read tests additionally fail closed when a mock snapshot is active in production. Cloud no-snapshot recovery is not yet exercised.

## Scenario: A valid query can return no matches

Given a complete non-empty catalog and an accepted search or filter combination
When no public pack matches the constraints
Then PackScout summarizes the constraints, offers Clear filters, and closes the inspector
And clearing restores the complete accepted query without treating the catalog as unavailable

Coverage: Automated local coverage — Convex query/filter tests and no-match state components preserve constraints, clear to canonical defaults, and close/fall back selection; desktop/mobile local-seed browser QA covers search and selection, while live reactive replacement and full focus evidence remain open.

## Scenario: A buyer learns before opening a pack

Given the public Learn section
When the buyer opens it or follows an EV glossary link
Then “PackScout Methodology,” “What Is a Repack?,” “What Is EV (Expected Value)?,” and “Repack Red Flags” are available
And every index summary links to its complete source-backed article
And an unknown article address returns not-found

Coverage: Automated plus browser coverage — Learn registry/content/route tests prove exactly four source-backed articles, stable slugs, summary-to-full-article links, complete methodology/repack/EV/red-flag content, and unknown-slug handling; desktop/mobile browser verification covers the index, all four articles, the EV table, and return navigation.

## Scenario: Theme initializes without a wrong-theme flash

Given a device with no explicit PackScout theme choice
When the shell first renders under light or dark operating-system preference
Then the matching approved theme and logo appear before visible content
And an explicit later choice persists locally with identical Dashboard content

Coverage: Automated plus browser coverage — theme bootstrap tests prove persisted/system resolution and storage fallback; light/dark browser review confirms correct logo/content parity with no wrong-theme hydration warning after the nonce fix.

## Scenario: The public experience is responsive and accessible

Given Dashboard and Learn in light and dark themes
When they are exercised at 1440×1000 and 390×844 by keyboard and pointer
Then all controls, tables, tooltips, sheets, states, and content remain readable and operable
And the All Packs table scrolls inside its region with no page-level overflow, console error, or hydration warning

Coverage: Partial browser coverage — 1440×1000 and 390×844 local reviews against the Convex-backed mock snapshot confirm visible mock provenance, search and selection, responsive content, internal-only table overflow, sheet focus/Escape return, and zero console/hydration warnings. HTTPS cloud-development smoke separately confirms visible mock provenance, search, and selection from `abundant-puffin-373`; full keyboard-only, contrast, 200% zoom/increased-text, reduced-motion, Playwright, and preproduction artifact evidence remains open.
