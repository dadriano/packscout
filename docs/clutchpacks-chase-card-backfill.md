# Clutchpacks chase-card backfill

Status: implemented; controlled local rollout and browser verification are required
before claiming the dashboard is populated. The design and source investigation
are recorded in [the backfill plan](chase-card-backfill-plan.md).

## Source and display semantics

The official unauthenticated collection endpoint supplies pack-specific
`price_bucket_odds[].preview_cards`. The reader makes one bounded request per
explicit canonical pack ID. It never queries pulls or reuses the import cursor.
It ignores `series_hits` and `pool_cards`: neither is part of this preview
capability's reviewed membership semantics.

Each accepted snapshot retains exact native identities, a source key, mapper and
adapter versions, observation time basis, completeness, and a canonical digest.
The public API has no upstream revision/time, so its timestamp is explicitly
`response_observed_at`. DataForrest observations retain `provider_updated_at`;
their later delivery time cannot make old source evidence current. An embedded
native pack ID must match the envelope's pack ID. Missing evidence emits no
replacement. Malformed membership cannot erase prior memberships or EV.

Single-response previews are complete only when every bucket reports no more
cards and its unique preview count equals its drawable count. Truncated previews
remain partial. There is deliberately no pagination in this backfill: the API
does not bind pages to an immutable inventory revision. Partial omissions never
retire known cards. Explicit complete removals retain retired history.

Published cards use `vendor_featured_chase` evidence, existing canonical images
and valuations with their original timestamps, and null individual-card odds.
The preview is evidence of a provider-listed outcome, not a guarantee that a
restocking pack can currently be purchased. No bucket odds are divided among
cards; no series-wide hit is assigned to every pack. Existing pack availability
and EV eligibility policy remain unchanged by this relationship-only backfill.

## Storage and ordinary imports

The additive provider migration
`20260831010000_provider_pack_content_snapshots` introduces immutable snapshot
receipts, an active membership uniqueness constraint and a same-pack source
receipt foreign key. Duplicate existing active memberships make migration fail;
the migration does not delete or repair them. Each snapshot and its material
membership changes append promotion entries in the same transaction.

The generic optional `normalized_pack_membership_v1` capability leaves historical
observations without membership instructions valid. The installed Clutchpacks
native adapter supplies it; the generic worker emits one snapshot after the pack
and card candidates. Other providers gain no native interpretation. Existing
4,000-record/8-MiB mixed-page and per-record bounds remain fail-closed. A rejected
referenced card or snapshot cannot partially replace a pack's membership.

An exact snapshot retry is inert. Older evidence cannot restore removed cards.
Equal effective time with different content is a conflict. Partial snapshots
retain older per-card receipt links for omitted members. Direct unproven
membership updates invalidate their receipt link and block governed publication.

## Local operation

This utility is owned by the local distributed-catalog operator. Replace it with
the governed catalog refresh job when that job supports the same source evidence,
checkpoint, fencing and publication contracts. It is not a cloud deployment tool.

Use the coherent checkout containing the reviewed EV retention, provider recovery
and membership changes. The utility reads the existing central authority only at
`127.0.0.1:55431/packscout`, resolves Clutchpacks through central configuration,
and allows only `127.0.0.1:55432/packscout_clutchpacks`. It requires an active
organization admin and does not accept a provider DSN or source token override.

1. Finish `npm run verify:framework` and independent rollout review. Record the
   exact commit, migration hash and gate log.
2. Coordinate a clean stop with the sole Clutchpacks resident owner. Verify its
   process/children are gone, the 56432 ownership port is free, no import lease or
   actionable work remains, runtime is idle, and the latest run succeeded at the
   source head. Keep every configuration, event cursor and quarantine intact.
3. Apply only the additive Clutchpacks provider migration. Do not migrate other
   provider databases or use a reset/provision utility to change existing data.
4. Capture a reviewable manifest from current public endpoints:

   ```bash
   npm run backfill:clutchpacks-chases:local -- --capture \
     --manifest /absolute/private/path/chases.json \
     --operation-id OPERATION_UUID --operator-id ACTIVE_ADMIN_UUID
   ```

   The file is exclusively created with owner-only permissions. The output gives
   its canonical digest and bounded coverage counts. It contains normalized
   membership and response hashes, not credentials or raw user activity.
5. Review the exact manifest, then check/apply that digest:

   ```bash
   npm run backfill:clutchpacks-chases:local -- --check-only \
     --manifest /absolute/private/path/chases.json --digest MANIFEST_SHA256
   npm run backfill:clutchpacks-chases:local -- --apply \
     --manifest /absolute/private/path/chases.json --digest MANIFEST_SHA256
   ```

   Check-only performs no source calls or writes. Apply claims the resident port
   and fenced import lease. Each pack's snapshot and separate audit checkpoint
   commit together. Resume uses the same operation and manifest; it never clears
   an event cursor, steals a foreign lease or invents a completed provider run.
   A changed source head/configuration/generation/cursor or unexplained ledger
   delta refuses execution.
6. Verify the completion receipt and unchanged EV/pack, source cursor, run and
   quarantine digests. Configure the exact approved image origin array through
   `PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLIC_ASSET_ORIGINS_JSON` (the verified card origin
   is `https://d18ez2bunk7yz0.cloudfront.net`). Run the existing local publisher's
   check-only/prepare path and complete its readiness and activation checks.
7. Publish through the existing provider release, manifest and V3 compare-and-set
   workflow. Verify pack `topChase`, card/chase counts, inspector references,
   search and retained EV through public readback and the browser. Resume the
   resident from the unchanged checkpoint in this coherent checkout, coordinated
   with the ingestion owner. Keep that checkout available for its process.

The completed audit receipt binds the exact before/after promotion range, change
digest, snapshot IDs/digests, configuration, original source head, full cursor
digest, generation and lease fence. Publication may use this separate catalog
settlement time without relabeling the old source run. Any unrelated post-head
change blocks publication. Configuration revision 3 explicitly permits this
local provisional-card projection while preserving the central-empty bootstrap
guards. Existing global catalog/correlations/profile still require a separate
governed migration; they are not silently ignored.

## Verification

Contract and source tests cover scope, finite capacities, native identity,
partial/missing evidence, unknown odds, image origins and hardened transport.
Real disposable PostgreSQL tests cover ordering, replay, concurrent snapshots,
removal/restock, unresolved/cross-instance identities, append-only receipts,
fencing, interrupted backfill/resume and preservation of pack/EV/event history.
Publication tests cover exact membership proof, audited settlement, provider/V3
references, images, search, values, top chase, EV preservation and unsafe origins.
The canonical full framework gate is required after all changes are assembled.
