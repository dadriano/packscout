# Technical Spec: Security, Performance, and Launch

**ID:** repack-dashboard/tech-004
**Related tasks:** repack-dashboard/001, repack-dashboard/002, repack-dashboard/003, repack-dashboard/004, repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/009, repack-dashboard/010, repack-dashboard/011, repack-dashboard/012
**Depends on technical specs:** repack-dashboard/tech-001, repack-dashboard/tech-002, repack-dashboard/tech-003
**Spec status:** draft

## Start Here

Open `apps/frontend/next.config.ts` and its behavior test, then replace the static permissive script/connect policy with a tested nonce policy whose production `connect-src` contains only the exact configured Convex HTTPS and WSS origins.

## Purpose

Launch the anonymous PackScout frontend with fail-closed browser boundaries, nonblocking partner actions and telemetry, measured catalog performance, and recorded real-data, accessibility, browser, recovery, and rollback evidence.

## Current System Context

### Confirmed repository facts

- `apps/frontend/next.config.ts` currently allows `'unsafe-inline'` and `'unsafe-eval'` scripts, any HTTPS image origin, and only `'self'` connections.
- `apps/frontend/next-config.behavior.test.ts` checks the baseline headers but does not test Convex origins, nonces, image hosts, or production/dev differences.
- `apps/frontend/app/layout.tsx` has one static light `themeColor` and no pre-paint theme resolution.
- There is no promo clipboard helper, outbound URL builder, telemetry endpoint, telemetry store, browser suite, or performance harness.
- `npm run verify:framework` is the canonical repository gate and may not be weakened or re-baselined to accept new findings.

### Confirmed launch boundary

PR #1 at `0dc6bcc25d73704b74fcfe865dd03e520c178a38` supplies internal provider health and canonical pipeline behavior after merge, but its scorecard has not proved real provider histories or incrementals. Public readiness therefore remains false until this spec's preproduction gate is recorded and approved.

V1 remains anonymous. Convex stores rebuildable catalog data and frontend-safe platform configuration; it does not store accounts or theme preference. Theme is local to the device. Anonymous product events are operational analytics, not canonical collectibles or user profiles.

## Proposed Implementation

### Browser security and theme

1. Add `apps/frontend/lib/security-policy.server.ts` to parse deployment origins, build CSP directives, and fail closed on invalid production configuration.
2. Add Next 16 `apps/frontend/proxy.ts` to generate one unpredictable nonce per request and set the same CSP on request and response headers.
3. Keep non-CSP headers in `apps/frontend/next.config.ts`, remove production `'unsafe-eval'`, and test the production and local-development policy separately.
4. Add a fixed, non-interpolated nonce-bearing theme bootstrap in `apps/frontend/app/layout.tsx` before application content.
5. Resolve explicit `packscout.theme` storage first, otherwise system preference, then set `data-theme`, `color-scheme`, and theme-color metadata before paint.

The theme bootstrap catches unavailable storage and falls back to `prefers-color-scheme`. Server markup uses system-aware CSS as its default and suppresses only the expected root theme-attribute hydration difference. Light and dark logos, data, controls, and state copy remain identical.

### Exact Convex CSP origins

Production requires `NEXT_PUBLIC_CONVEX_URL` in the exact form `https://<deployment-name>.convex.cloud`. The policy derives, validates, and emits only:

```text
connect-src 'self' https://<deployment-name>.convex.cloud wss://<deployment-name>.convex.cloud
```

Do not add `*.convex.cloud`, a generic `https:` or `wss:`, or a `.convex.site` origin. V1 uses Convex queries/subscriptions and the same-origin Next telemetry route, not Convex HTTP actions. Local development may emit only the exact `http://localhost:<port>` or `http://127.0.0.1:<port>` origin supplied by `NEXT_PUBLIC_CONVEX_URL` plus its matching `ws://` origin; a local origin in a production build is fatal.

The production policy also includes `default-src 'self'`, `script-src 'self' 'nonce-<per-request>' 'strict-dynamic'`, `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and `frame-ancestors 'none'`. `img-src` contains only `'self'`, `data:`, and exact HTTPS origins from the validated build-time `PACKSCOUT_PUBLIC_IMAGE_ORIGINS`; it no longer contains the broad `https:` source.

The build derives `PACKSCOUT_PUBLIC_ORIGIN_SET_HASH` from the sorted exact image-origin set. Preproduction/live set the same expected hash in the frontend and Convex deployment; `tech-002` rejects activation when a snapshot manifest's `originSetHash` differs. A config change that adds/removes an image origin therefore deploys the CSP/expected hash before publication, and the launch gate proves build-time origins, manifest count/hash, and Convex activation policy agree.

### URL-state logging boundary

URL state intentionally contains raw `q`, `cursor`, `cursorStack`, and normalized query `fingerprint`, so application logging must omit the full query string rather than serialize or partially redact it. `apps/frontend/lib/public-request-log.server.ts` accepts a route pathname plus approved bounded outcome fields only; `proxy.ts`, route loaders, error handling, telemetry, and observability never pass `request.url`, `searchParams`, raw query, cursor, cursor stack, or fingerprint into logs or event stores. Preproduction and live edge request logging must exclude query strings through an explicit platform setting or a documented equivalent transform before retention.

The launch privacy test opens a URL containing unique sentinel values in all four fields, exercises server preload plus reactive failure, and proves the sentinels are absent from captured application logs, retained edge request logs, telemetry rows, public-read outcomes, and launch artifacts. Missing edge-log access or an unproved equivalent keeps the launch gate closed.

### Partner-action boundaries

- `apps/frontend/lib/outbound-link.client.ts` accepts only a published `PackActionConfiguration`, never an arbitrary clicked URL or platform-specific branch.
- It parses HTTP(S), requires the exact approved origin, rejects userinfo, preserves the existing fragment and unrelated query parameters, and applies each configured referral key with `URLSearchParams.set` exactly once.
- Production publication permits HTTPS listing origins; HTTP remains local-fixture-only and fails preproduction/live validation.
- `apps/frontend/lib/clipboard.client.ts` writes the exact displayed public promo code only during direct user activation and returns a typed outcome.
- A clipboard failure reveals a selected read-only field for manual copy; a link-validation failure omits the link or leaves sold-out behavior disabled.

Open the validated provider URL in a new tab with `noopener,noreferrer` during the direct activation. Start `pack_link_opened` telemetry only after the browser has accepted the navigation, and never await telemetry before copy or navigation.

### Anonymous telemetry lifecycle

1. Browser helpers create one random event ID per completed outcome and send one bounded event to `POST /api/telemetry` with `keepalive` or `sendBeacon`.
2. The route enforces the exact same-origin, fetch-metadata, media-type, byte, timestamp, and event-context boundary defined below.
3. The edge limiter rejects per-source abuse without forwarding or retaining its source key; the database circuit breaker caps accepted environment-wide writes.
4. The service deduplicates the event ID for 24 hours, writes only the discriminated fields, and stores no request header, IP address, cookie, user agent, or device ID.
5. A retry-safe worker aggregates raw events daily, then enforces the 24-hour receipt, 30-day raw, and 13-month aggregate retention policies.

Raw-event reads require `product_events:raw` and are restricted to Engineering operations with an audited purpose and bounded time range. Daily-aggregate reads require `product_events:aggregate` and are available to Product and Engineering owners. No browser or public endpoint reads either store.

### Telemetry request boundary

1. Reject `Content-Encoding` other than absent/`identity`, a declared length above 4,096 bytes, or an actual UTF-8 body above 4,096 bytes before JSON parsing.
2. Require `Origin` to equal the configured PackScout public origin exactly and require `Sec-Fetch-Site: same-origin`; reject missing or mismatched values.
3. Require a `Content-Type` media type of `application/json`, one JSON object, and a strict discriminated schema with no unknown keys.
4. Require a UUID event ID and UTC `Z` timestamp no more than five minutes old or one minute in the future at receipt.
5. Enforce route-specific context: product events require the active or safe previous complete snapshot, subject events require a public pack/platform pair in that snapshot, non-subject events omit both fields, and failure beacons obey the exact query/surface/code/snapshot rules below.

Both telemetry and public-read-failure routes use this boundary. Origin/fetch failures return 403, unsupported media returns 415, oversized bodies return 413, invalid schema/time/context returns 400, and rate limits return 429 with the stable application envelope.

### Freshness and operational thresholds

- Public status is fresh while `now - catalogState.lastSuccessfulObservationAt <= 15 minutes` and no source is delayed; it becomes delayed above 15 minutes or immediately when sanitized delayed-source count is nonzero.
- Every successful reconciliation, including an unchanged one, atomically refreshes `catalogState.lastSuccessfulObservationAt`; unchanged content uses a metadata-only refresh and does not mint or rewrite an immutable snapshot.
- A failed reconciliation or staged publication does not advance `lastSuccessfulObservationAt`, never replaces the active snapshot, and leaves the last complete content readable.
- Internal alerting begins when successful-observation age reaches 30 minutes or when no complete active snapshot/observation exists; a subsequent successful reconciliation clears age-based delay and alert state when no source remains delayed.
- The browser may cross the public 15-minute boundary from `lastSuccessfulObservationAt` without announcing every relative-time tick; internal 30-minute alert decisions remain server-owned.

After PR #1 merges, `PublicCatalogObservabilityService` records server-preload outcomes, PostgreSQL publication-ledger state, reconciliation state, `catalogState.lastSuccessfulObservationAt`, derived successful-observation age, and delayed-source count. It emits typed operational events through the existing `packages/services/src/operational-events.ts` and routes deduplicated alert/open/recovery decisions through `operational-alert-service.ts`. Client reactive failures send the strict `/api/public-read-failure` beacon. A worker evaluates one-minute catalog health plus five-minute read buckets; it alerts when no complete snapshot/observation exists, successful-observation age reaches 30 minutes, reconciliation fails, or preload failure rate reaches 5% with at least 20 attempts, then resolves the same alert key on recovery. Reactive failure volume is reported separately because it has no complete success denominator.

### Performance and launch gates

Build deterministic sanitized fixtures at 1,500 and 10,000 public packs. Both sizes must exercise active, sold-out, unavailable EV, unavailable price, missing images, all approved sorts, contextual facets, relevance search, cursor navigation, and selected detail.

| Gate | Required result |
|---|---|
| Public rows | UI default at most 25; public boundary rejects more than 50 |
| Query response | Representative search/filter/sort replacement completes within 1 second in preproduction at both fixture sizes |
| Serialized data | Dashboard bundle at most 128 KiB, catalog page at most 256 KiB, detail at most 32 KiB before compression |
| Mobile paint | Preproduction mobile LCP p75 at or below 2.5 seconds over a recorded repeated run |
| Bounded work | No full-catalog browser load, unbounded image fan-out, unlimited cursor stack, or unbounded telemetry batch |

Use responsive images with explicit dimensions, priority only for the initial above-fold pack image, and lazy loading for table/chase images below the fold. A missing or failed pack image renders the neutral PackScout pack placeholder; a missing or failed chase image renders the chase name/value text-only and never substitutes the pack placeholder. Keep the previous accepted result during a replacement query so immediate local feedback does not depend on network completion.

## Code Changes

### Frontend security and action paths

| Path | Change |
|---|---|
| `apps/frontend/proxy.ts` | Per-request nonce, exact CSP, and production/dev configuration enforcement |
| `apps/frontend/lib/security-policy.server.ts` and `public-request-log.server.ts` | Pure validated policy/origin builder plus pathname-only application-log boundary, with no browser import |
| `apps/frontend/app/layout.tsx` | Nonce-aware anti-flash theme bootstrap and PackScout metadata |
| `apps/frontend/next.config.ts` | Retain HSTS, frame, content-type, referrer, and permissions headers; remove static CSP ownership |
| `apps/frontend/lib/outbound-link.client.ts` and `apps/frontend/lib/clipboard.client.ts` | Browser-only referral and clipboard result boundaries |

Add `apps/frontend/lib/telemetry.client.ts` for nonblocking event delivery, `apps/frontend/app/api/telemetry/route.ts` for product outcomes, and `apps/frontend/app/api/public-read-failure/route.ts` for the strict reactive-read failure beacon. UI components consume these helpers; they do not implement URL, clipboard, CSP, or telemetry policy inline.

Add `convex/publicTelemetryValidation.ts` with a bounded boolean-only query over `catalogState` and `publicPacks`; only the two Next server routes import its generated reference. It accepts no tenant selector and validates the active/safe-previous snapshot plus optional pack/platform subject without returning catalog detail.

### Post-PR-merge service paths

| Path | Change |
|---|---|
| `packages/contracts/src/product-analytics.ts`, `public-observability.ts`, and `auth.ts` | Exact strict unions, stable results, and raw/aggregate permissions |
| `packages/services/src/anonymous-product-event-service.ts` and `public-catalog-observability-service.ts` | Context validation, dedupe, access policy, ledger/read/snapshot health, and integration with existing operational events/alerts |
| `packages/database/src/schema/product-analytics.ts` and `public-observability.ts` | Product-event, claim/processed, coarse dead-letter aggregate, limiter, read-outcome, and health-bucket tables |
| `packages/database/src/anonymous-product-event-repository.ts` and `public-observability-repository.ts` | Atomic insert/limit/aggregate/dead-letter/retention and bounded observability operations |
| `apps/worker/src/anonymous-product-event-retention.ts` and `public-catalog-observability.ts` | Scheduled retry-safe aggregation/retention and one-minute health/read monitoring |

Export new shared modules only through each package's public `src/index.ts`. The Next browser bundle may import types or runtime-neutral schemas from `@packscout/contracts`; only the server route may import the service entry point. No frontend client file imports `packages/services`, `packages/database`, Node-only helpers, secrets, or deep `/src/` paths.

### Verification paths

Add `@playwright/test` to `apps/frontend/package.json`, `apps/frontend/playwright.config.ts`, and executable coverage in `apps/frontend/e2e/repack-dashboard.spec.ts`. The config defines desktop/mobile light/dark projects plus the two 1536×1024 exact-comp projects and writes screenshots, traces, and HTML results to scoped artifact folders.

Add guarded runners at `scripts/local/run-repack-dashboard-browser.mjs`, `scripts/preproduction/run-repack-dashboard-browser.mjs`, `scripts/local/repack-dashboard-performance.mjs`, and `scripts/preproduction/repack-dashboard-performance.mjs`. Their root commands are `test:browser:frontend:local`, `test:browser:frontend:preproduction`, `test:catalog-performance:local`, and `test:catalog-performance:preproduction`; none is part of `npm test`.

Local runners accept only `localhost` or `127.0.0.1`. Preproduction runners require `PACKSCOUT_TEST_SCOPE=preproduction`, an exact HTTPS `PACKSCOUT_PREPRODUCTION_ORIGIN`, and refusal when it equals the configured live origin. Store the sanitized evidence record at `docs/launch/repack-dashboard-v1.md`.

## Database / Schema Changes

### Anonymous event storage after PR #1 merges

| Table | Bounded fields and retention |
|---|---|
| `anonymous_product_event_receipts` | Hash/event ID, received time, expiry; unique during the 24-hour idempotency window |
| `anonymous_product_events` | Exact event fields, claim/processed fields, bounded attempt/error category, occurred/received times; every raw row has a hard 30-day maximum |
| `anonymous_product_event_daily` | Day, approved dimensions, event count, success/failure counts; 13 months |
| `anonymous_ingress_rate_limits` | Environment/minute bucket and atomic accepted count for the 5,000-write global circuit breaker; no client/network identity |

Use explicit columns rather than arbitrary metadata JSON. Index receipt expiry, unprocessed/claim state, raw-event expiry, aggregate day/dimensions, and rate-bucket expiry. No raw or quarantined event-level copy may survive 30 days.

`anonymous_product_event_dead_letter_daily` stores only day, approved event name, bounded failure category, and count for 13 months; it contains no event ID, snapshot, pack, platform, query, or network field. When an unprocessed row reaches the 30-day cutoff or ten failed attempts, a bounded worker transaction locks it, increments this coarse daily count, and deletes the raw row atomically. Crash rolls back both; any dead-letter count raises an Engineering alert and marks product aggregates incomplete for that day.

### Public observability storage after PR #1 merges

| Table | Bounded fields and retention |
|---|---|
| `public_read_outcomes` | Query name, route surface, server/client source, stable code, nullable snapshot version, retained-result flag, occurred/received times; no query, cursor, pack, platform, or network identity |
| `public_catalog_health_buckets` | Environment/minute, preload attempt/failure counts, reactive failure counts, publication/reconciliation state, `lastSuccessfulObservationAt`, derived observation age, delayed-source count, and alert state |

The server preload wrapper records both success and failure so its five-minute failure rate has a denominator. `/api/public-read-failure` records only client reactive failures. Retain outcome rows 30 days and health buckets 13 months through bounded worker operations.

### Retry-safe aggregation transaction

1. Begin one database transaction and select at most 500 rows where `aggregation_processed_at IS NULL` using `FOR UPDATE SKIP LOCKED` in received-time/ID order.
2. Assign one `aggregation_claim_id` UUID and `aggregation_claimed_at` to the locked rows without committing the claim separately.
3. Upsert the grouped daily counters and mark those exact claim rows with `aggregation_processed_at` in the same transaction.
4. Commit once; a crash before commit rolls back claim, counters, and processed markers, while retry after commit finds no eligible row.
5. Run multiple workers safely because locked rows are skipped and the processed predicate prevents replayed increments.

The cutoff/dead-letter transaction uses the same `FOR UPDATE SKIP LOCKED` discipline and a maximum of 500 rows. Privacy retention wins over indefinite retry: processed rows delete normally by received time, and failed/unprocessed rows become only coarse dead-letter counts before their event-level row is deleted at 30 days.

No canonical catalog table changes are owned here. Do not put product events, theme preference, or CSP policy into `catalogSnapshots`. `tech-002` owns the snapshot-scoped approved platform-config array/origin-set hash and copied pack action/media fields; `tech-003` only reads them. Secret or operator-only configuration remains server-side.

## Interfaces, APIs, and Endpoints

### Outbound and clipboard results

```ts
type OutboundLinkResult =
  | { readonly ok: true; readonly href: string }
  | {
      readonly ok: false;
      readonly code:
        | "MISSING_LINK"
        | "SOLD_OUT"
        | "UNAPPROVED_ORIGIN"
        | "INVALID_REFERRAL_CONFIG";
    };

type ClipboardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "CLIPBOARD_UNAVAILABLE" };
```

The URL builder accepts the exact published listing URL, approved origin, availability, and a bounded array of unique referral key/value pairs. It never accepts provider credentials, a tenant selector, raw provider configuration, or a caller-supplied allowlist.

### Telemetry endpoint

`POST /api/telemetry` accepts one strict JSON event no larger than 4 KiB:

```ts
type AnonymousEventBase = {
  readonly schemaVersion: "anonymous-product-event-v1";
  readonly eventId: string;
  readonly snapshotVersion: string;
  readonly occurredAt: string;
};

type AnonymousProductEvent =
  | (AnonymousEventBase & {
      readonly name: "dashboard_view";
      readonly surface: "overview" | "all_packs";
      readonly outcome: "rendered";
    })
  | (AnonymousEventBase & {
      readonly name: "catalog_search";
      readonly surface: "all_packs";
      readonly outcome: "results" | "no_matches" | "failed";
      readonly queryLengthBucket: "1-20" | "21-60" | "61-120";
      readonly resultCountBucket: "0" | "1-25" | "26-100" | "101+";
    })
  | (AnonymousEventBase & {
      readonly name: "filters_applied";
      readonly surface: "overview" | "all_packs";
      readonly outcome: "results" | "no_matches" | "failed";
      readonly activeFilterCount: 0 | 1 | 2 | 3;
      readonly resultCountBucket: "0" | "1-25" | "26-100" | "101+";
    })
  | (AnonymousEventBase & {
      readonly name: "promo_copied";
      readonly publicPackId: string;
      readonly platformKey: string;
      readonly outcome: "clipboard" | "manual_fallback" | "failed";
    })
  | (AnonymousEventBase & {
      readonly name: "pack_link_opened";
      readonly publicPackId: string;
      readonly platformKey: string;
      readonly outcome: "opened" | "blocked";
    });
```

```ts
type AnonymousEventResponse =
  | { readonly ok: true; readonly status: "accepted" | "duplicate" }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code:
        | "ORIGIN_REJECTED"
        | "UNSUPPORTED_MEDIA"
        | "PAYLOAD_TOO_LARGE"
        | "INVALID_EVENT"
        | "INVALID_CONTEXT"
        | "RATE_LIMITED"
        | "EVENT_UNAVAILABLE";
    };
```

Action UI ignores telemetry transport failure.

Deployment must enforce 60 requests per minute per source with a burst of 20 at the edge. The edge key exists only in limiter memory for at most two minutes, is not forwarded to the app, and is excluded from route access logs. Independently, `anonymous_ingress_rate_limits` atomically rejects the 5,001st combined telemetry/public-read-failure write in one environment/minute; this global circuit breaker stores no source identity.

### Public read failure beacon

`POST /api/public-read-failure` uses the same exact request boundary and accepts only:

```ts
type PublicReadFailureBeacon = {
  readonly schemaVersion: "public-read-failure-v1";
  readonly eventId: string;
  readonly queryName:
    | "getPublicShellStatus"
    | "getDashboardBundle"
    | "listPublicPacks"
    | "getPublicPack";
  readonly routeSurface: "overview" | "all_packs" | "learn" | "article" | "not_found";
  readonly errorCode:
    | "INVALID_QUERY"
    | "CURSOR_EXPIRED"
    | "SNAPSHOT_UNAVAILABLE"
    | "PACK_NOT_FOUND"
    | "TRANSPORT_UNAVAILABLE";
  readonly snapshotVersion: string | null;
  readonly retainedPreviousResult: boolean;
  readonly occurredAt: string;
};
```

Reject query/error combinations that cannot occur, any raw query/cursor/pack/platform field, and a snapshot version other than the active or safe previous complete snapshot. `TRANSPORT_UNAVAILABLE` is a local observability classification for failures outside a successful Convex handler; it is not a `PublicResult` application code. The route returns the same stable acceptance/error envelope and never changes the user's retained-result behavior.

### Internal analytics access

No public or anonymous read endpoint is added. `product_events:aggregate` permits Product and Engineering owners to read daily aggregates only. `product_events:raw` permits Engineering operations to read at most seven days per audited request inside the 30-day retention window; Product has no raw access. Direct database grants follow the same split, and permission-denial/audit behavior has direct tests.

## Data Flow

### Promo and outbound action

1. The selected `PackDetail` supplies only approved public action configuration.
2. Direct activation runs the pure URL or clipboard boundary and receives a typed result.
3. Copy success announces locally; copy failure exposes manual selection without losing focus.
4. Valid outbound navigation opens immediately with safe new-tab behavior; invalid or sold-out input cannot navigate.
5. The completed outcome queues telemetry without delaying or changing the user's result.

### Telemetry and retention

1. The same-origin route validates one strict event and enforces size/rate boundaries.
2. The edge limiter handles per-source abuse; one database transaction atomically claims the global minute bucket, inserts the unique 24-hour receipt, and inserts one raw row only when that receipt is new.
3. The worker locks at most 500 unprocessed rows with `FOR UPDATE SKIP LOCKED` inside one transaction.
4. That transaction assigns the claim, increments exact daily aggregates, marks rows processed, and commits once.
5. Bounded retention removes all 30-day raw rows; cutoff failures atomically become coarse dead-letter counts, while receipts/buckets and 13-month aggregates expire separately.

### Launch evidence

1. Preproduction runs real no-cursor history and durable incrementals for every launch stream.
2. Reconcile accepted, quarantined, canonical, estimated/unavailable, published, searchable, and rendered counts with explicit exclusions.
3. Exercise product, failure, accessibility, browser, and performance matrices against the same complete snapshot.
4. Demonstrate failed publication, delayed status, recovery, previous-snapshot activation, and canonical full rebuild.
5. Record sanitized evidence and obtain authorized review before enabling live data labels.

## Error Handling and Edge Cases

| Cause | Handling |
|---|---|
| Missing or invalid production Convex/image origin | Fail build/start; never widen CSP to recover |
| Theme storage unavailable or corrupt | Ignore it, resolve system theme before paint, and keep the control operable for the session |
| Clipboard denied or unsupported | Return `CLIPBOARD_UNAVAILABLE`, reveal the exact code for manual selection, announce once |
| Listing absent, sold out, malformed, or origin-mismatched | Omit or disable the action; do not navigate and do not add referral data |
| Telemetry timeout, duplicate, rate limit, or storage failure | Preserve the user's action; bound retries to the same event ID within 24 hours |

A pack image that fails after publication uses the neutral PackScout pack placeholder and does not retry indefinitely. A chase-image failure removes only the image and retains the chase name/value text-only; it never uses the pack placeholder. A source that becomes delayed retains the last complete snapshot; failed observation does not advance `catalogState.lastSuccessfulObservationAt`. No public copy exposes provider name, internal run, tenant, quarantine, stack, or failure code, and a 30-minute internal alert does not replace the public delay that begins above 15 minutes.

## Testing and Verification

### Automated security and action coverage

- Extend `apps/frontend/next-config.behavior.test.ts`; add `apps/frontend/lib/security-policy.server.test.ts` and `public-request-log.server.test.ts` for nonce/origin fail-closed cases plus sentinel `q`/cursor/cursor-stack/fingerprint exclusion from application, edge, telemetry, observability, and launch-artifact logs.
- Add outbound-link and clipboard helper tests at `apps/frontend/lib/outbound-link.client.test.ts` and `apps/frontend/lib/clipboard.client.test.ts` for referral-origin/parameter safety, blocked URLs, exact copy text, denied API, manual fallback, and focus preservation.
- Add telemetry and public-read-failure route tests for Origin, `Sec-Fetch-Site`, JSON media type, actual 4 KiB bytes, time window, strict union, context, stable errors, and both limit layers.
- Add aggregation tests for crash/replay/concurrency, `SKIP LOCKED`, ten-attempt/30-day dead-letter atomicity, no event-level copy after cutoff, 24-hour receipts, and 13-month aggregate expiry.
- Add observability/access tests for preload-rate denominator, reactive failure counts, 30-minute alerts, reconciliation, raw denial for Product, bounded audited Engineering raw reads, and aggregate access.

### Performance gate

Run the preproduction harness against deterministic 1,500- and 10,000-pack fixtures. Record environment, commit, Convex deployment, fixture hash, cold/warm status, at least 20 representative runs per query family, p50/p75/p95 latency, documents/bytes read, serialized response bytes, and failures.

The gate fails when either fixture exceeds one-second result replacement, any payload cap, the 50-row public maximum, Convex read limits, or deterministic page/relevance behavior. Record repeated mobile-browser runs sufficient to calculate LCP p75; do not substitute a single Lighthouse score or claim an unmeasured production percentile.

### Accessibility and browser evidence

- Compare Overview against the final comps at 1536×1024, then run every V1 flow at 1440×1000 and 390×844 in both themes.
- Complete every V1 interaction by keyboard; record tab order, visible focus, sortable table semantics, glossary dismissal, modal focus containment/return, and live announcements.
- Check 200% zoom, increased text, reduced motion, contrast, missing images, long names, internal table scrolling, and absence of page-level overflow.
- Record console errors, hydration warnings, broken-image loops, request failures, screenshots, and any explicit automation gap with owner/follow-up.
- Verify referral parameters and promo codes against approved preproduction configuration without completing a purchase.

### Executable browser and performance commands

| Command | Required guard and output |
|---|---|
| `npm run test:browser:frontend:local` | Localhost-only; runs Playwright projects and stores local traces/screenshots/report |
| `npm run test:browser:frontend:preproduction` | Exact approved HTTPS preproduction origin; refuses live origin and stores preproduction artifacts |
| `npm run test:catalog-performance:local` | Localhost-only deterministic 1,500/10,000 fixture measurements |
| `npm run test:catalog-performance:preproduction` | Exact approved preproduction origin; records release-candidate latency/bytes/LCP evidence |

Install the pinned Chromium runtime during environment setup. These four environment-aware commands are explicit launch gates and remain outside `npm test`; test discovery continues to run only the existing unit/behavior lanes.

### Repository and launch verification

Run focused tests first, then `npm run check:boundaries`, `npm run lint:frontend`, `npm run typecheck:frontend`, `npm run test:frontend`, and `npm run build:frontend`. Before handoff, run and record `npm run verify:framework` without checker exceptions or a new ratchet baseline, then run the separately guarded browser and performance commands required for the target environment.

`docs/launch/repack-dashboard-v1.md` records the exact commit, environment, fixture/real-stream identifiers, sanitized count reconciliation, freshness/alert timings, performance matrix, browser/accessibility matrix, telemetry retention/access owner, verified preproduction/live edge query-string exclusion or documented equivalent, sentinel privacy-test evidence, rollback commands, evidence links, automation gaps, and authorized reviewer decision.

## Open Questions and Risks

No product or architecture questions remain for this slice.

- A nonce-bearing Next response can reduce static caching; the repeated LCP and query gates determine whether route composition needs optimization without weakening CSP.
- An approved media host can change independently of a frontend build; publication omits the new host until publisher and exact CSP configuration are deployed together.
- Public telemetry can attract automated traffic; strict schemas, 4 KiB requests, infrastructure rate limits, bounded storage, and no user identity limit impact.
- Clipboard and new-tab behavior vary by browser policy; direct activation, manual fallback, and action-before-telemetry preserve the primary outcome.
- Real provider correctness remains unproved until the preproduction reconciliation and recovery gate passes; no document may claim readiness earlier.

## Handoff Notes

1. Land `repack-dashboard/tech-003` and generated Convex guidance compliance before finalizing CSP origins or route browser tests.
2. Implement and directly test CSP, theme bootstrap, URL, clipboard, and telemetry boundaries before connecting UI controls.
3. Run the 1,500- and 10,000-pack fixture gate before visual completion so query/index defects return to their owning spec.
4. Complete the six responsive viewport/theme combinations plus the two exact-comp comparisons and accessibility evidence against the release candidate.
5. Finish with real preproduction reconciliation, failure/recovery/rollback demonstrations, `npm run verify:framework`, and authorized launch review.
