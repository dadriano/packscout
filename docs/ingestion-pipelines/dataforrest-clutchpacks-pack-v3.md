# DataForrest ClutchPacks pack adapter v3

Status: current contract and isolated local replay workflow

Owner: PackScout data platform

## Corrected V1 source semantics

The DataForrest endpoint and raw envelope remain V1. New source revisions use
`dataforrest-events-adapter-v3`; adapter v1 and v2 remain registered only to
interpret their already-pinned history.

For a ClutchPacks `catalog` / `pack` record, adapter v3 reads only this reviewed
allowlist:

- `name` and `description` as trimmed display text;
- `collection_type.type` as the preferred category, falling back to
  `category.name` only when `collection_type` is absent;
- `image_url` as an HTTPS image reference;
- `price.price_amount` with exact `USD` / two-decimal currency evidence;
- `average_value` as vendor-reported average value, matching the label on the
  official ClutchPacks checkout surface;
- the exact series statement
  `Instant buyback offer of 90%. One graded or authenticated card per pack.` as
  a 90% vendor-reported buyback;
- `price_bucket_odds` as complete per-pack EV evidence, using positive
  `drawable_count` inventory to derive probabilities and excluding zero-count
  buckets; and
- boolean `sold_out: true` as explicit authoritative sold-out evidence.

The odds adapter ignores the rounded provider percentage when calculating
coverage. It requires unique bucket IDs, nonnegative integral inventory, exact
USD ranges, positive total inventory, one draw per pack, and complete derived
coverage. Unknown buyback prose stays absent and does not prevent otherwise
complete EV evidence from becoming ready.

Malformed allowlisted fields fail closed. Nested IDs, status prose, previews,
and every other native field remain protected provenance.

## Replay and publication

Do not reinterpret adapter-v1 or adapter-v2 pages in place. Follow the guarded
[ClutchPacks V3 local canary](./clutchpacks-v3-local-canary-runbook.md) to replay
from Feed start into the fresh local `packscout_clutchpacks_v3_canary` database.
After the exact provider-head pause and reconciliation proof, use the
[V3 public candidate workflow](./clutchpacks-v3-public-catalog-candidate-runbook.md)
to approve taxonomy, listing URLs, and public identities before publishing to
the isolated Convex deployment. Neon remains out of scope for this replay.
