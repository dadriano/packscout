# P07 current frontend datapoint inventory

Read-only inventory audited against main `8616bfd5041f490a0334ca4beef2a2e4f26ed88e` (PR117), retaining the PR115 canonical-source audit. Sources below are repository-relative; older line numbers are historical pointers where PR117 moved presentation. User clarification: native V1 must support every current frontend datapoint. No Heat or global catalog release identity is reintroduced. This inventories rendered values and behavior, not every unused property in the old DTO. Main audit is not certification of unfinished V1 extensions.

## PR117 presentation reconciliation

- `VendorIdentity.tsx:5-14` maps stable vendor keys to approved local logo assets; unknown vendors render no logo. Preserve the key and asset mapping, not an obsolete assumption that `vendorLogoUrl` feeds current logos. Provenance: `docs/frontend-vendor-logos.md`.
- `PackScoutEvMetrics.tsx:23-40` now places confidence limitations/reasons, calculation-price/zero-payout notes, and freshness timestamps in evidence popovers. All remain required datapoints.
- `PackInspector.client.tsx:264-271,390-419` moves provider-health and vendor EV source/observation/reason evidence into popovers. `MetricValue.tsx:62-79` retains unavailable reasons and accessible evidence in value hints.
- `CatalogSummaries.tsx:52` moves median source/semantic descriptions into link titles; `OverviewKpis.tsx` retains values, reasons and accessible descriptions. Numerical semantics and formulas are unchanged.
- Guest Save retains “Sign in to save”, empty helper copy, and accessible empty status. Development-only local preview is not production authentication or a second catalog path.
- The restacked frontend foundation passes584/584 tests across99 files, zero skips/quarantines, lint/types, ratchet and317-file docs. Log: `/tmp/packscout-p07a-main117-focused-20260904.log`. This does not certify unfinished native data parity or the full framework gate.

## Pack display and identity

| Current displayed datum/behavior | Current source and renderer | Native P01/P05 availability / required correction |
|---|---|---|
| Stable pack identity in selection, action, save, deep link | `publicRepackId`; `AllRepacksClient.client.tsx`, `PackInspector.client.tsx`, `SavedItemButton.client.tsx` | Available: summary + snapshot. Keep stable identity, add per-pack snapshot evidence; remove only global release identity. |
| Pack title/name, pack image + accessible image alt | `name`, `primaryImage.{url,alt}`; `AllRepacksTable.client.tsx:47` passes them to `CatalogImage.client.tsx:23`; inspector also renders image | `title`, `imageUrl` available; preserve nullable images, supplied alt, missing/failed-image fallback and accessible image-unavailable text. Do not reject valid packs solely because the image is absent. |
| Provider/vendor name, logo; stable vendor key in filters/actions/telemetry | `vendorDisplayName`, `vendorKey`, `publicVendorId`; `VendorIdentity.tsx:5-14` selects approved local assets from vendorKey, used by inspector/table; `telemetry-contract.ts:56` | Current profile displayName/brandAssets and providerId available. Existing public vendor slug key is missing; preserve vendor URL meaning and current local logo mapping. |
| Multiple category labels, hierarchical category selection | `categories[].{publicCategoryId,label}`; `PackInspector.client.tsx:350`, `AllRepacksTable.client.tsx:122` | V1 summary exposes one category only. Full member categories are sealed but not necessarily all in current content page. Native summary must carry bounded complete pack categories. |
| Mixed-content badge | `contentMode === "mixed"`; `AllRepacksTable.client.tsx:135` | Missing. Could be sealed/derived from complete pack type set at assembly, never guessed from one page. |
| Simulated-data badge | Name pattern via `isSimulatedRepackListing`; `overview-presentation.ts:162`, EV presenter | Existing derived name behavior can be retained without adding a field; avoid changing it incidentally. |
| Availability available/unavailable/unknown/sold_out; descriptive reason | `availability`; `pack-availability-presentation.ts` used in cards/table/inspector/Watchlist | Available in lifecycle. New explicit retirement is additionally required everywhere action eligibility is shown. |
| Display/source-currency pack price, USD comparison or bounded reason | `price.displayMoney`, `price.usdComparison.{status,value,reason}`; `packscout-ev-presentation.ts:398`, `PackInspector.client.tsx:379` | V1 `price` is a single required money. Need source display price + available/unavailable USD comparison and reasons to preserve unsupported currency/missing price behavior. |

## Independent and provider-reported EV

| Current displayed datum/behavior | Source and renderer | Native gap |
|---|---|---|
| Gross EV $, Gross EV %, EV $, EV % | `evEstimates.packScout.metrics.{grossEvMoney,grossReturnBasisPoints,evDollars,evPercentBasisPoints}`; `AllRepacksTable.client.tsx:149-159`, `PackScoutEvMetrics.tsx:15`, `packscout-ev-presentation.ts:689` | V1 has only `ev.amount`. All four source metrics must be sealed explicitly with the existing calculation-time price and method/policy; no economics recalculation in UI. |
| Confidence value, score, band; limitation tooltip | `confidence.{scoreBasisPoints,band,limitationCodes}`; `PackScoutEvMetrics.tsx:91`, `CatalogConfidenceEvidence.client.tsx:53` | Missing. Carry safe public confidence evidence and exact policy identity. |
| Current / last known / sold-out historical / unavailable label and bounded reason | `status`, `reason`, `latestUnavailableReason`, `historicalSoldOutAt`; `packscout-ev-presentation.ts:704-724` | V1 only available/unavailable. Preserve retained public values and reason semantics; freeze economics, keep presentation clock evidence explicit. |
| Source freshness age/state, delayed source label | `sourceAge.{milliseconds,state}`; `packscout-ev-presentation.ts:522`, `CatalogConfidenceEvidence.client.tsx:29` | Missing. Do not replace source-observation time with fetch/evaluated time. |
| Calculated timestamp | `calculatedAt`; `PackScoutEvMetrics.tsx:172` | V1 evaluatedAt is not explicitly the same source meaning. Seal correct timestamp. |
| Source evidence last observed, or Unknown | `dataAsOf.{state,observedAt}`; `PackScoutEvMetrics.tsx:183` | V1 snapshot dataAsOf exists but does not carry the EV known/unknown state contract. |
| Confidence evaluated timestamp | last-known `confidenceEvaluatedAt`, other statuses use calculatedAt; `PackScoutEvMetrics.tsx:195`, presenter:527 | Missing explicit read presentation evidence. |
| Sold-out timestamp | `soldOutAt` or `historicalSoldOutAt`; `PackScoutEvMetrics.tsx:204` | Lifecycle evidence has observedAt but not the EV history meaning. Preserve correct sealed sellout reference. |
| Calculation-price note when current pack price differs from retained calculation price | `calculationPriceUsdMinor`; `packscout-ev-presentation.ts:722` | Missing. Required to avoid relabelling older metrics as calculated from the current price. |
| Zero-payout note and unavailable reasons | Source metrics + public reason vocabulary; presenter:689 | Only derive the zero note from sealed metrics, retain exact reason semantics. |
| Buyback rate or Varies / Fixed or final payout / Not documented / Unavailable | `buyback.{kind,rateBasisPoints?}`; `AllRepacksTable.client.tsx:169`, `PackInspector.client.tsx:451`; contract `data-release-v3-ev-estimates.ts:418` | Entire public summary missing. Do not infer an average rate from valuations or EV. |
| Vendor-reported original-money EV, USD comparison, unavailable reason, observation timestamp | `evEstimates.vendorReported.{status,sourceMoney,usdComparison,observedAt,reason?}`; `PackInspector.client.tsx:421`, presenter:865 | Entire separate source missing. Keep independent source labels/observation. |
| Provider-derived gross/net four metrics when independent estimate unavailable; “Platform EV × buyback” and source observation | `vendorReportedGrossEvV3(repack)` uses vendor EV/buyback/price; `packscout-ev-presentation.ts:814`, `PackScoutEvMetrics.tsx:46` | Currently calculated by existing canonical helper in browser. Native V1 should publish the exact established result + source discriminator; no new formula or approximation. Root's domain reviewer maps formula/provenance. |
| Provider-feed healthy/delayed/unavailable, observed timestamp | `providerHealth.{state,observedAt}`; `provider-health-presentation.ts:24`, `PackInspector.client.tsx:404`, confidence tooltip:29 | Missing from P01 profile/summary. This is current displayed user data; earlier task out-of-scope line conflicts with user's newer preserve-all direction. Preserve sanitized status only, not internal causes. |
| Snapshot/source data-as-of caption | `release.dataAsOf`; `PackInspector.client.tsx:460` | Replace global release reference with selected pack snapshot dataAsOf; same user-visible timestamp meaning must be explicit. |

## Chase and collectible display

| Current displayed datum/behavior | Source and renderer | Native gap |
|---|---|---|
| Top chase name, image, stable collectible ID and value | `topChase.collectible.{name,primaryImage,publicCollectibleId,valuation}`; `PackInspector.client.tsx:477`, `AllRepacksTable.client.tsx:177` | V1 topChase has only stable ID, valuation identity and amount. Native summary must carry sealed compact display so top chase does not require scanning 8,000 members or joining a mutable profile. |
| Selected chase inspector hero even with zero matching packs | `ChaseCollectibleInspector.client.tsx:195` reads `desiredCollectible`; `convex/publicRepacksV3.ts:1303` returns exact-ID profile display independently from matches | Add native selected collectible profile/display to desired lookup. A known collectible with zero matches remains renderable; an unknown ID returns COLLECTIBLE_NOT_FOUND. Never derive the hero from a matching pack or a name-search round trip. |
| Chase inspector match ordering | `desired-collectible-repacks.ts` sends ID + limit; `packages/contracts/src/public-repacks-query.ts:267` defaults match_confidence descending; `convex/publicRepacksV3.ts:1261` uses numeric score and stable pack-ID ties | Preserve this distinct query order from sealed per-pack match-confidence score, not EV or confidence-band text. Regression must separate score ordering from EV ordering and cover ties. |
| Desired chase per-pack name/image/value | `desiredChaseMatches[].chase`; table/cards/inspector | V1 desired query returns only pack summaries; add exact matching sealed member display/evidence for each pack. |
| Chase evidence label (“Confirmed by vendor evidence”, inferred/resolved/possible) and match-confidence band | `chase.evidenceKinds`, `matchConfidence.band`, observedAt; `pack-inspector-presentation.ts:56`, `AllRepacksTable.client.tsx:186`, chase inspector | Missing. Separate match confidence from EV confidence. |
| Market value source currency/optional USD comparison; valuation type Market estimate/Vendor reported/Last sale/Appraisal; bounded unavailable reason | `collectible.valuation.{displayMoney,usdComparison,valuationType,observedAt}`; `chase-collectible-presentation.ts:41` | V1 valuation gives one money+identity+observedAt or two reasons only. Need valuation type and display/comparison semantics. |
| Collectible descriptor: type, year, brand, set/series, card number, reference, grade and grader | `collectible-identity.ts:19-54`, desired dropdown:335, Watchlist rows:48 | Only name/image/category/aliases exist in V1 collectible profile; all descriptor fields missing. Required in standalone current profile + sealed pack-local display where used. |
| Search by descriptor and aliases | `buildPublicCollectibleSearchText` in `data-release-v2-entities.ts:123` | V1 searchText only name+aliases; preserve descriptor search meaning by native canonical derivation. Do not omit supplied year/grade/card/reference query matches. |
| Matching pack title, vendor, price, chase evidence/confidence, exact total vs shown count | `ChaseCollectibleInspector.client.tsx:209,267`, `chase-collectible-presentation.ts:121` | Pack basics partly available via profile join; exact total and matching chase evidence absent from V1 desired result. |
| Full contents, quantities, odds and per-member valuation | New P07 requirement | V1 content page already exposes complete sealed fields, with snapshot-pinned continuation. Preserve new functionality while extending display metadata. |
| Estimate evidence coverage tooltip | `contentSummary.{evidenceCompleteness,probabilityCoverageBasisPoints}`; inspector presentation; `promote-provider-data-release-v3-contents.mts:30` binds latest membership receipt completeness | Missing query summary field. Membership completeness is not EV odds completeness. `distributed-provider-pack-contents.ts:336` retains unknown probability coverage as null. Preserve distinct sealed evidence and unknown states; never infer quantities, identities or complete membership from complete EV buckets or a content page. |

## Actions, saves, Watchlist

| Current displayed datum/behavior | Source and renderer | Native gap |
|---|---|---|
| Promo label + literal code; copy button, clipboard success/failure/manual text selection | `actions.promo.{label,code}`; `PackInspector.client.tsx:158-215`; row action buttons | V1 actions have only URL/label. Provider promotion copy is free prose, not a code. Add a bounded typed promo-code representation. Apply new active+available gate to promotions as requested. |
| Purchase destination and referral parameters | `actions.repackLink.{listingUrl,listingHost,referralParameters}`; `pack-actions.client.ts:53` | Native action URL can carry a fully validated final URL, but must preserve intended referral parameter effects and approved origin. Do not silently lose referral behavior. |
| Row-level separate promo/purchase eligibility | `actionAvailability.{promo,repackLink}`; `all-repacks-table.ts:69` | One `hasEnabledAction` cannot determine which row action to show. Native summary needs bounded per-kind eligibility. |
| Saved stable IDs, save/remove result, independent capacity bounds | `api.savedItems.getSavedItemIds/setSavedRepack/setSavedCollectible`; `AuthenticatedSavedItemsProvider.client.tsx` | Three named operations are already V1. Frontend needs exact errors, bounded retained messages, truth reconciliation after pruning and no optimistic drift. |
| Watchlist repack/collectible counts and tabs | `OwnerWatchlist.savedRepackCount/savedCollectibleCount`; `WatchlistPage.client.tsx:296` | `getSavedItemIds` can derive counts, but current owner listing response is separate V3 path. |
| Saved row stale/unavailable indicator, stable identity fallback, openable flag, remove after missing head | `WatchlistRepackRow` / `WatchlistCollectibleRow`; `watchlist.ts:15,34,218,249` | Need V1 resolution preserving stale rows; do not silently prune them on listing. |
| Saved pack title/vendor/image/lifecycle/compact EV money+signed percent+confidence | `WatchlistRepackRow.repack`; `watchlist.ts:238`, `packscout-ev-presentation.ts:267` | Basic identities/profile join available; compact EV+confidence missing. Include retirement in native lifecycle display. |
| Saved collectible full descriptor/image; detail opens same chase inspector; pack detail uses stable route | `WatchlistCollectibleRow.collectible`; `WatchlistPage.client.tsx:498`, `WatchlistInspectHost.client.tsx:156` | Descriptor missing; current `getOwnerWatchlist` still resolves `publicRepacksV3` and must be rewired. |
| Save order | Backend `savedAt` is present; rendered list follows returned order | Keep stable owner saved order; not a displayed timestamp today. |

## Dashboard, filters, pagination, status

| Current displayed datum/behavior | Source and renderer | Native gap |
|---|---|---|
| Exact matching pack count | `kpis.totalRepacks`; `overview-presentation.ts:101` | Dashboard totalMatchingPacks available for lifecycle only; extend full filter behavior. |
| Median displayed EV %, metric available/unavailable reason; source label (PackScout/platform/mixed) | `kpis.medianPackScoutEvPercent`, `evMedianSources.overall`; `overview-presentation.ts:81-113` | Missing. Cannot derive exact catalog median from at most 50 returned opportunities. |
| High-confidence pack count | `kpis.highConfidenceRepacks`; same renderer | Missing, requires native full-scan/aggregate rules from sealed confidence facts. |
| Highest chase USD value across matching catalog | `kpis.highestChaseValueUsdMinor`; presenter:89 | Missing, cannot safely derive from EV-sorted page. |
| Opportunity rows and ordering/rank | `opportunities[]`; `OpportunityTable.client.tsx`, `overview-presentation.ts:143` | Packs available but exact existing displayed-source EV ordering needs native metric projection; rank may derive from position. |
| By-vendor and by-category groups: key, label, count, median EV %, median source, relative count bar, filter-link destination | `vendorSummaries/categorySummaries`, `evMedianSources.{vendors,categories}`; `CatalogSummaries.tsx:26`, overview presenter:186 | All aggregate groups absent. Bar ratio may derive from returned exact group counts; do not create groups by counting current page. |
| Vendor facet key/name/count/selected | `facets.vendors[]`; `CatalogFilters.client.tsx:291` | Only page provider profiles available; need contextual complete options/counts and stable vendor-key meanings. |
| Hierarchical category facet key/label/count/selected/parent/depth | `facets.categories[]`; `CatalogFilters.client.tsx:310`, `catalog-filters-presentation.ts:53` | V1 lacks hierarchy and facets; preserve category ancestry behavior, not flat page-only options. |
| Collectible-type facet key/label/count/selected | `facets.collectibleTypes[]`; filters:333 | V1 lacks type filter/projection. |
| Price range full/narrowed and minimum/maximum; full includes missing USD comparison, narrowed excludes it | `filters.price.{mode,minMinor,maxMinor}`; filters:104,365-438 | Missing. Preserve $1–$12,000 current bounds and existing segmented step behavior; contract must support full vs narrowed meanings. |
| Default available vs all-state toggle | `filters.availability`; filters:477 | V1 lifecycle selection supports richer states. Preserve existing `availability=all` URL meaning while additionally exposing retirement. |
| Sort names: repack, repack_price, packscout_gross_ev, packscout_ev_dollars, packscout_ev_percent, packscout_confidence, buyback_percent, top_chase_value | `all-repacks-table.ts:24-38`; `CatalogResultsControls.client.tsx:36` | V1 only title/price/ev/top_chase; preserve exact current accepted names and their semantics. No Heat sort. Old vendor_reported_ev_percent is already unsupported today. |
| Text search vs relevance ordering; search text and desired stable selection across other query changes | `CatalogResultsControls.client.tsx:40`; `AllRepacksClient.client.tsx:100,186`; route state | V1 substring matching/order currently differs; native search must preserve relevance behavior. Desired operation presently cannot combine provider/category/price/type/text filters. |
| Current page range start/end/total, previous/next, page size 12/25/50, table/cards view | `CursorPagination.tsx`, `AllRepacksClient.client.tsx:437-447`, results controls:80 | Native result has nextCursor only. Exact range/total missing; previous cursor stack can remain local and bounded. |
| Canonical URL accepted query + stable selected pack/chase; fingerprint and bounded cursor recovery | `catalog-query-state.client.ts` | Foundation must follow expanded native schema; hold premature old-param rejection. Reset only pagination state on expiry; selection cleared only after PACK_NOT_FOUND. |
| Latest catalog source-record update timestamp and relative age in shell; loading/unavailable states | `public-release-status.ts:6`, `DataReleaseStatus.client.tsx:109`, `data-release-status.client.ts:69` | V1 shell evaluatedAt is fetch time, not latest source-record update. Need native latest source update across active pack/profile public records; no global release ID. |
| Provider partner banner | Route flags and static `provider-banner.ts` / ProviderBanner | Existing static assets/config independent from API; preserve. Dynamic profile promotions/brand assets are additional V1 behavior. |

## Telemetry and errors

Existing event datapoints to preserve: surface, outcome, stable publicRepackId, vendorKey, queryLengthBucket, resultCountBucket, activeFilterCount, promo clipboard outcome and purchase-opened/blocked outcome (`telemetry-contract.ts:18-70`). Replace global publicReleaseId with native schema/query fingerprint on catalog events and stable pack+publicPackSnapshotId on pack events. Do not transmit raw query text/cursor/credentials.

Existing failure telemetry uses operation name, routeSurface, bounded code and retainedPreviousResult (`telemetry-contract.ts:97`); retain bounded non-raw semantics. Native public error schema is currently INVALID_QUERY/CURSOR_EXPIRED/CATALOG_UNAVAILABLE/PACK_NOT_FOUND/COLLECTIBLE_NOT_FOUND/AUTH_REQUIRED/UNAUTHORIZED. Map authentication and authorization distinctly; cross-package extension can add explicit dependency/conflict codes only if canonical contract owns them.

Existing null/unavailable states are datapoints, not missing implementation licenses. Never fabricate a price, valuation, EV metric, confidence, promo code, source timestamp, total or facet when the source lacks it.

## Integration/removal implications

- V1 loader/type foundation is safe to build against inferred contract types; native query URL work should await expanded accepted schema.
- `convex/savedItems.ts:686,812` still uses `loadActiveDataReleaseV3/loadDesiredChases` for owner Watchlist despite three named saved operations being V1. V3 catalog cannot be deleted before owner read migration.
- `publicRepackValidation.ts` is still consumed by schema, productUserSavedItems, savedItems, providerCatalogDependentWrites, and fixture/search code. Do not delete as a frontend-only change.
- Dead frontend Heat helpers have no live catalog component imports; deletion can be independently verified later.
- Existing inspector does not render pack description; source `description` is in DTO but need not be expanded solely from that unused field. Existing format is also not directly rendered; contentMode is rendered and collectibleTypes supports active filters/search.
- Full contents are a new task acceptance requirement and remain in scope in addition to all current datapoints.
- PR115 source semantics: wholly absent valuation with canonical `source_unavailable` remains public null; source collectible type `art` is publicly `other`; Clutchpacks formatted-current-price valuation remains `vendor_reported`. These are source/presentation rules, not new formulas or fabricated values.
- Reviewed Courtyard/Collector Crypt/Phygitals published EV buckets can be complete while member identities/counts remain unknown. Task011 must preserve both facts independently; an odds-only record does not satisfy V1's complete-pack publication admission.
