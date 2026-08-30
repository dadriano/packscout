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
   frontend.
5. Re-read the provider snapshot and both public Convex read models. The
   manifest-backed and V3 repack identity sets must match exactly.

ClutchPacks currently has no approved central public profile or public
category/collectible correlations. The projection therefore exposes the real
pack identities, prices, availability, provider EV, buyback statements,
descriptions, and images, while publishing no listing actions, categories,
collectibles, chases, or PackScout EV estimate. This is an explicit limitation,
not mock data.

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
