# Distributed ClutchPacks local Convex preview

This local-only lane promotes the already-settled distributed ClutchPacks
checkpoint into the repository's existing immutable publication contracts. It
does not start an import, consume a queued command, create a central
correlation, or restore the retired Postgres-backed frontend schema.

## Contract path

1. Resolve ClutchPacks through the central provider-database gateway.
2. In a repeatable-read provider transaction, require an idle runtime, no
   running run, no active import lease, one contiguous promotion ledger, and
   an unchanged successful source-head checkpoint.
3. Build the existing provider release and activate the existing global
   catalog manifest through signed publication clients.
4. After exact active-manifest readback, publish the same real repack identities
   through the existing `data_release_v3` contract consumed by today's
   frontend. At this promotion boundary, normalize each retained pack's EV
   evidence and run the shared buyback EV calculator and confidence policy.
5. Re-read the provider snapshot and both public Convex read models. The
   manifest-backed and V3 repack identity sets must match exactly. V3 EV
   projections must match the promotion plan or a pinned predecessor's retained
   valid EV. Top Opportunities ranks available packs with known EV by signed
   EV dollars; source age changes confidence, not the stored values.

ClutchPacks currently has no approved central public profile or public
category/collectible correlations. Local configuration revision 3 preserves that
explicit bootstrap guard and adds deterministic provisional collectible IDs for
source-proven pack memberships. It publishes referenced collectibles, chase
records, top chase and content summaries together, using configured HTTPS image
origins. It still publishes no direct listing actions or invented categories.
See [the chase backfill workflow](../../docs/clutchpacks-chase-card-backfill.md).
The V3 frontend receives a PackScout EV estimate when the retained odds and
documented buyback terms support one; age lowers confidence without hiding values.

The importer retains a strict, normalized `attributes.evInputEvidence` object;
it does not compute EV or retain raw response bytes there. Promotion binds
that evidence to the provider, pack row version, source time, price, and
buyback terms before calculation. It uses the real promotion clock for
calculation while preserving the source's `collectedAt` observation time.
Re-promotion cannot refresh old observations. Missing inputs produce explicit
unavailable calculation states; public reads retain an earlier valid estimate
when one exists. Malformed or mismatched evidence refuses publication.
Vendor-reported EV is never substituted for calculated EV, and the existing
positive-EV publication restriction remains in force.

The public display follows `docs/last-known-ev-display.md`: values never expire
solely because of age. Confidence is evaluated at the read clock and decays to
zero while original calculation/source times and the original price basis stay
unchanged. Convex retains validated values by provider and pack across later
unavailable publications and catalog removal. New valid calculations replace
them; a later failed calculation keeps the old values with zero confidence.

The older manifest read model retains its existing EV semantics. The
buyback-adjusted calculation is published through V3; no conversion between
the two EV contracts is introduced. Public configuration revision 3 also records
the membership projection. A new provider release still requires a genuinely newer settled
promotion ledger sequence. Changing the configuration alone cannot invent a
new checkpoint.

When only retained odds or other non-public facts change, the signed provider
protocol confirms reuse of the unchanged public content at the newer real
checkpoint. The manifest records that actual terminal receipt. An unchanged
checkpoint with different observation or queue freshness still refuses; this
local tool does not manufacture a sequence or refresh the source clock.

Sold-out packs have no proven sellout timestamp or frozen historical estimate
in this provider snapshot. Their retained inputs are validated, but they stay
EV-unavailable until that history exists; a new calculation is not published
as historical EV.

Packs imported before evidence retention must receive a valid source
observation before they can have calculated EV. Use the normal provider
import path and require a completed source-head checkpoint before promotion.
Do not reset saved cursors or rewrite source/run timestamps to manufacture
eligibility.

Acceptance coverage:

- Automated: normalized odds retention and raw-data exclusion in
  `apps/worker/src/provider-normalized-ev-evidence.test.ts`.
- Automated: provider evidence binding, missing inputs, and freshness in
  `packages/services/src/providers/clutchpacks/promotion-ev-evidence.test.ts`.
- Automated: promotion calculation, immutable source clocks, positive-EV
  restriction, and snapshot binding in
  `scripts/local/distributed-clutchpacks-publication-plan.test.mjs`.
- Automated: release identity, exact retained EV, confidence age, and dashboard ranking
  readback in `scripts/local/distributed-clutchpacks-public-readback.test.mjs`.

## Commands

With the local Convex deployment selected in root `.env.local` and the local
central credential bootstrap available only in the process environment:

```bash
npx convex dev --typecheck enable --tail-logs disable
node --import tsx scripts/local/promote-distributed-clutchpacks-to-local-convex.mts --check-only
node --import tsx scripts/local/promote-distributed-clutchpacks-to-local-convex.mts
```

The promotion creates three random, distinct process-only signing keys, stores
them temporarily in the selected local Convex deployment through stdin, and
attempts removal of every owned key and role variable on both success and
failure. It verifies that they are absent before reporting ready; an uncertain
cleanup fails the command rather than claiming success. Preexisting or
subsequently replaced authority values are never removed as if they were owned
by this invocation. The non-secret runtime environment and exact public
image-origin-set hash remain configured because the active provider read model
uses them to verify its governing hash.

Root `.env.local` is not automatically loaded by a Next.js process whose app
root is `apps/frontend`. Start the review frontend with the exact values emitted
or derived from the publication plan:

```bash
env \
  NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210 \
  PACKSCOUT_PUBLIC_IMAGE_ORIGINS=https://d18ez2bunk7yz0.cloudfront.net \
  PACKSCOUT_PUBLIC_ORIGIN_SET_HASH=4236666b58ad31bb65fee309c4ef440f89da47ef98e7d6e0bb5b61bc4ebababd \
  npm run dev --workspace=@packscout/frontend
```

Review the exact selected-provider result at:

`http://127.0.0.1:5100/packs?vendor=clutchpacks&availability=all&pageSize=50`

The command output is sanitized: it reports checkpoint, document counts, and
immutable public release identifiers, but never database credentials or
publication key material.

## Neon database with the existing local Convex deployment

The same command may read the centrally routed ClutchPacks database in Neon.
This does not change the Convex destination: the selected existing deployment
must still be local, with matching loopback client/site URLs and no cloud deploy
key. Do not run `convex dev` or replace the existing local deployment as part of
this database change. The EV retention readiness probe must already pass; the
publisher does not deploy schema or run that migration.

Remote database access requires `PACKSCOUT_DATABASE_MODE=remote`, the exact
`PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS` and
`PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS` allowlists, and the approved central
URL for logical database `packscout`. Central TLS must verify the certificate;
the central provider route must use port 5432, `verify-full`, logical database
`packscout_clutchpacks`, and the matching immutable provider identity. Missing
mode or allowlists do not enable remote access. Production mode is refused.

Set `PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLICATION_SCOPE_JSON` in the protected process
environment to canonical JSON with exactly these sorted keys:

```json
{"configVersionId":"<approved-config-UUID>","configVersionNumber":"<positive-decimal-version>","operatorId":"<active-admin-UUID>","organizationId":"<approved-organization-UUID>","providerId":"<approved-ClutchPacks-UUID>"}
```

Use the exact active configuration and operator from the reviewed continuation
handoff. Scope is never inferred from another tenant's row. Before and after
every provider snapshot, the publisher rechecks the active admin membership,
organization, configuration, logical database and allowed route. A route change
also changes the stability fingerprint and refuses the old plan.

First finish the authorized import through a successful source-head checkpoint,
then drain its sole resident without changing that checkpoint. Publication
requires idle runtime, no running run, and no live import lease. Run the existing
`--check-only` command, review its eligibility counts, then run the command
without that flag. Check-only performs bounded database/Convex reads, no lease
claim, authority installation or publication. Execution obtains the normal
exclusive import fence and requires no queued run or actionable command before
publishing. It never enables another provider or consumes import work.

Retained membership receipts, original EV observation clocks and the signed
provider, manifest and V3 transition checks remain unchanged. Preserve the
before/after checkpoint and EV/chase digests, verify both public read models,
verify temporary signing-authority cleanup, and only then hand import scheduling
back to the resident owner.
