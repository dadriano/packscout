# Provider pack listing links

The normalized importer writes `listingUrl: null` for every pack. The
existing `packs.listing_url` column and public `repackLink` action already support
links; no database migration is required.

## Reviewed identity mapping

DataForrest catalog `record_id` is retained unchanged as the normalized
`providerRecordId`, then as the provider database key `pack:<record_id>`.

| Provider | Catalog identity | Public route |
| --- | --- | --- |
| Phygitals | Native pack slug | `https://www.phygitals.com/repacks/<slug>` |
| Phygitals (legacy) | Numeric pack id | `https://www.phygitals.com/repacks/<recorded slug>` |
| Collector Crypt | Native machine code | `https://gacha.collectorcrypt.com/gacha/<code>` |

Fifteen legacy Phygitals packs (catalog ids 13 through 41, for example the
[Rookie Pack](https://www.phygitals.com/repacks/rookie-pack)) carry the
platform's numeric pack id as their catalog identity. A numeric id does not
route (`/repacks/13` is a 404), so the registry maps those ids to the slug the
feed publishes for them, recorded on 2026-09-04 and verified page by page. A
numeric id outside that table produces no link.

The Phygitals catalog links directly to the [50/50 pack](https://www.phygitals.com/repacks/5050-pack-bssaa3)
and [Mini 50/50 pack](https://www.phygitals.com/repacks/mini-5050-pack-hbwr8g).
The Collector Crypt [Grail pack page](https://gacha.collectorcrypt.com/gacha/pokemon_1000)
selects the PKMN1000 tab and shows the $1,000 Grail Pokémon pack. Query-string
selectors are not part of this mapping.

The shared provider registry accepts bounded lowercase slugs/machine codes only;
URLs, paths, encoded characters, queries, fragments and unknown providers produce
no link. Native adapter admissions are unchanged: this derives routing from the
already normalized identity and does not interpret additional native fields.
This fix only changes public promotion. Importer behavior, canonical content and
source fingerprints stay unchanged. Persisting links during import requires a
separate versioned admission because same-source replay cannot change material
canonical pack fields.

## Existing-row repair

The provider promoter fills missing `listing_url` values in its in-memory snapshot
using the same registry and exact `pack:` identity. Existing stored URLs remain
authoritative. PostgreSQL remains read-only, and no reingest is necessary for
the public release. Existing HTTPS validation and available-only purchase actions
still apply.

This is a bounded repair for rows produced by the current null-writing importer.
Owner: provider ingestion/promotion. Remove the promoter enrichment once a
verified provider snapshot shows that a separately reviewed importer admission
has populated all eligible canonical listing URLs. Move the registry to that
admission when it is implemented.

Read-only inspection on 2026-09-03 found 73 active canonical rows per provider,
all with usable route identities and all missing `listing_url`. With the normal
priced-pack promotion filter, 11 Phygitals and 24 Collector Crypt available packs
qualify for purchase actions. Courtyard had no active canonical packs and has no
reviewed route registered here.

## Acceptance coverage

- Valid provider IDs, unsupported providers and unsafe IDs:
  `packages/contracts/src/provider-pack-listing-url.test.ts`.
- Existing-row enrichment, stored-link precedence and available-only public action:
  `scripts/local/promote-provider-data-release-v3-plan.test.mjs`.

Run `npm run verify:framework` before delivery. Publication uses the existing
provider promotion command and its dry-run review, deployment allowlist and
predecessor-bound activation checks.
