# Provider catalog promotion acceptance

The provider promotion command reads canonical packs, active contents, and the
latest membership receipts in one read-only repeatable-read transaction. Public
projection uses the receipt's completeness, not the pack's descriptive
`content_evidence` field. EV is calculated from reviewed, source-bound evidence;
advertised vendor EV never substitutes for that evidence.

## Acceptance map

| Given / when / then | Coverage |
|---|---|
| Given an imported pack with unknown descriptive completeness and a retained membership snapshot, when promoted, then its contents, chases, and receipt completeness publish successfully for every launch provider. | Automated: `scripts/local/promote-provider-data-release-v3-contents.test.mjs` |
| Given a complete empty snapshot, when promoted, then counts and chases are empty and completeness remains complete. A partial update preserves older active members and their original observation times. | Automated: `scripts/local/promote-provider-data-release-v3-contents.test.mjs` |
| Given active membership without a receipt, or duplicate, invalid, or future receipt evidence, when promoted, then publication is refused. Price-excluded packs cannot leak collectibles into the release. | Automated: `scripts/local/promote-provider-data-release-v3-contents.test.mjs` |
| Given canonical absent valuation, a reviewed provider valuation source label, or provider type `art`, when projected, then public values are respectively unavailable, vendor reported, or type `other`. Contradictory and unknown metadata still fail. | Automated: `packages/services/src/distributed-provider-pack-contents.test.ts` |
| Given Phygitals decimal percentages that produce floating-point tails after division, when normalized and promoted, then the exact published distribution remains calculable. Missing, malformed, and unrepresentable probabilities remain unavailable. | Automated: `packages/services/src/providers/phygitals/promotion-ev-evidence.test.ts` and `providers/buyback-ev-published-probability.test.ts` in the same package |
| Given supported Courtyard or Collector Crypt published odds and value ranges, when retained under the new adapter identity and promoted, then PackScout EV is calculated with unknown item counts. Absent or malformed evidence cannot become an available estimate. | Automated: `packages/contracts/src/dataforrest-published-odds-pack-v2.test.ts` and `packages/services/src/providers/published-probability-promotion-ev-evidence.test.ts` |
| Given a new adapter configuration, when the worker resolves it, then the matching provider can execute it and a different provider cannot. Previous adapter identities remain installed with unchanged interpretation. | Automated: `apps/worker/src/provider-dataforrest-live-integration.test.ts` and `packages/services/src/provider-source-integration-capability.test.ts` |

## Source versions and rollout

The new evidence interpretations use new adapter identities. Existing adapters
retain their original meaning; changing an existing source's adapter is an
explicit configuration advance, followed by catalog reingestion.

| Provider | Adapter carrying promotion EV evidence |
|---|---|
| ClutchPacks | Existing distributed adapter and count-based evidence |
| Phygitals | `dataforrest-phygitals-distributed-adapter-v4` |
| Courtyard | `dataforrest-courtyard-distributed-adapter-v4` |
| Collector Crypt | `dataforrest-collector-crypt-distributed-adapter-v4` |

After deploying these readers, advance the relevant source configuration to its
listed version and reingest catalog packs to retain fresh evidence. Validate the
provider promotion dry-run plan before publishing. Existing older rows that lack
reviewed EV input continue to publish unavailable EV until reingested.

Pack membership is separate evidence. Providers that do not supply membership
retain unknown contents; published odds do not establish collectible identities
or inventory. A card without an image does not require a configured image origin;
every actual image still must satisfy the public origin allowlist.

No database migration, live source configuration change, production reingestion,
or publication is performed by these code changes.

## Verification

Run focused contents, provider evidence, and adapter registration tests, then the
canonical `npm run verify:framework` gate. Do not suppress or extend timeouts to
hide failures. Record any environment-dependent skips and incomplete phases in
the handoff.
