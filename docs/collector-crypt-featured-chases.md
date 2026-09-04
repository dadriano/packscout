# Collector Crypt featured chase evidence

The official machine page requests `/api/getNfts?code=<machine>&page=1&limit=40`
for its current card grid. Recent Winners uses a separate feed. The response
contains `nfts`, `hasMore`, exact mint identity (`id` equals `nft_address`), name,
image, and `insured_value`. A first page establishes a partial advertised
selection, not full inventory, quantities, or draw probabilities.

`parseCollectorCryptFeaturedChasesV1` admits this shape and returns only the
bounded public card fields and partial membership. The caller must bind the
response hash and observation time to the exact requested machine code. The
parser must not receive a Recent Winners response, a collection-wide card list,
or a card chosen by name matching. Native mint identities use `card:<mint>`;
the existing warehouse's numeric card keys are not assumed equivalent.

The provider renders insured values with a USDC icon. Preserve that currency:
canonical `valuation_currency = USDC`, `valuation_usd_amount = null`,
`valuation_unavailable_reason = CURRENCY_UNSUPPORTED`, and
`valuation_type = vendor_reported`. Public display renders `USDC 45,000.00`;
USD ranking remains unavailable. Within a pack, values with the same currency
can select the highest valued advertised chase without a currency conversion.

The new image origin is `https://d1xpxki1g4htqu.cloudfront.net`. It must pass the
normal production image-origin configuration approval and hash update before
publishing an image from it.

## Canonical backfill boundary

Use `ProviderCanonicalTransaction.upsertCollectible` and
`applyProviderPackContentSnapshot` inside the existing fenced import/backfill
transaction. Bind provider identity, source configuration/revision, response
hashes, exact machine keys, and observation times. Keep the source key
`collector_crypt:featured_nfts:v1`. The existing snapshot writer refuses older
knowledge, unresolved references, conflicting source keys, and retired cards.
Partial snapshots do not remove other membership or imply that omitted cards
are no longer obtainable.

Do not bypass the backfill readiness check when the provider runtime is in an
error state or its last source-head run failed. Recovery must precede writes.
This change provides parsing and publication support; it does not change
worker credentials, source cursors, worker state, or authorize an unfenced write.
The current native CC mapper omits `packMembership`; omitted facts cannot clear
an accepted snapshot. Automatic ongoing ingestion of the official featured
stream remains a separate source integration; no historical capture is made
current by restamping it.

## Acceptance coverage

| Scenario | Evidence |
| --- | --- |
| Exact machine response admits public identity and unconverted value | `collector-crypt-featured-chases-v1.test.ts` |
| Duplicate/mismatched identities, unexpected image hosts and historical-only payloads refuse | Same contract tests |
| Empty or final first page remains partial with no inferred odds or stock | Same contract tests |
| Canonical membership publishes in V3 while preserving EV | `provider-pack-content-promotion.test.mjs` |
| Missing snapshot refuses; missing membership leaves top chase unknown | Same promotion tests |
| Higher USDC value wins without invented USD value | `provider-pack-content-promotion.test.mjs` |
| Source currency remains visible when USD is unavailable | `packscout-ev-presentation.test.ts` |

The promotion script reads membership, referenced active collectibles, and
snapshot evidence in the same repeatable read as packs. It uses the shared
content projection, preserves unrelated carried entities, and requires
`PACKSCOUT_PUBLIC_IMAGE_ORIGINS` for every newly projected chase image.
