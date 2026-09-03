# Public catalog image origins

The frontend CSP uses `PACKSCOUT_PUBLIC_IMAGE_ORIGINS` and its SHA-256
`PACKSCOUT_PUBLIC_ORIGIN_SET_HASH`. Promoting a provider's image URL into the V3
catalog does not automatically admit that URL in the browser's `img-src` policy.
Configure exact HTTPS origins on the frontend project and rebuild it after a
provider adds an image host. Keep this separate from the legacy Convex origin-set
configuration; V3 catalog releases do not require changing that legacy hash.

## Reviewed production configuration

As of 2026-09-03, the Vercel project is `pack-scout/packscout-frontend`, with root
directory `apps/frontend`. These values retain the existing ClutchPacks, card,
and placeholder origins and add the observed provider pack-image origins:

```dotenv
PACKSCOUT_PUBLIC_IMAGE_ORIGINS=https://api.courtyard.io,https://d18ez2bunk7yz0.cloudfront.net,https://degwuxynwtb2zaso.public.blob.vercel-storage.com,https://images.pokemontcg.io,https://placehold.co,https://storage.googleapis.com,https://xexhjcyxgwxfopyobhmk.supabase.co
PACKSCOUT_PUBLIC_ORIGIN_SET_HASH=0811f492080098e5e98d1d636ff9b9762de311d62af178ae0e031f79c0567d51
```

| Provider | Observed pack-image origin | Source and HTTP verification |
| --- | --- | --- |
| Phygitals | `https://xexhjcyxgwxfopyobhmk.supabase.co` | Stored provider pack image; HTTP 200, `image/webp` |
| Collector Crypt | `https://degwuxynwtb2zaso.public.blob.vercel-storage.com` | Stored provider pack image; HTTP 200, `image/png` |
| Courtyard | `https://api.courtyard.io` | Captured `sealedPackImage`; HTTP 200, `image/png` |
| Courtyard | `https://storage.googleapis.com` | Captured `sealedPackImage`; HTTP 200, `image/png` |

The boundary test in `apps/frontend/lib/security-policy.server.test.ts` includes
the observed image URLs and verifies that only these exact origins are added.
Shared hosting domain wildcards are not needed.

## Update and verification

1. Read the frontend production origin set, preserve its existing entries, and
   add only origins supported by provider image URLs. Check those URLs return
   images. Compute the hash with `hashImageOriginSet` from
   `apps/frontend/lib/security-policy.server.ts`: SHA-256 of the JSON-encoded,
   lexicographically sorted origin array.
2. Update both production environment variables together using Vercel's batch
   environment upsert. Preserve their target/type and all unrelated variables.
   Read back both values and validate them with `readPublicSecurityConfiguration`
   before starting a deployment.
3. Resolve the deployment currently assigned to `www.packscout.com` and rebuild
   its exact Git commit using the updated project environment. The latest build
   with a production target may not be the deployment serving the domain. Record
   the previous alias, source commit, new deployment ID, and URL. Validate the
   candidate before promoting it through the normal Vercel production flow;
   this project does not automatically assign its custom domains to each build.
4. Check the production `/packs` response CSP contains every required exact
   origin, then open the provider filter in a browser and confirm images load.
   Packs without a source image should retain their existing placeholder.

Focused boundary verification:

```bash
node --import tsx --test apps/frontend/lib/security-policy.server.test.ts
```

For rollback, restore the previously recorded environment pair and redeploy the
previous source commit. Do not remove unrelated origins added after this snapshot.
