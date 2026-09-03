# DataForrest ClutchPacks card adapter v2

Status: historical adapter-v2 contract; superseded by adapter v3

Owner: PackScout data platform

## Corrected V1 source semantics

DataForrest's endpoint and raw record envelope remain V1. Adapter-v2 revisions
use `dataforrest-events-adapter-v2`, normalized observation
`packscout.provider-observation.v1`, and ClutchPacks mapper revision `1`.

For a ClutchPacks `catalog` / `card` record, adapter v2 reads only this exact
`data.asset` allowlist:

- `title` as the canonical display name;
- `description` as the canonical description;
- `subtype` as the canonical category;
- the full, medium, and thumbnail front/back image URL fields, in that order,
  with duplicates removed; and
- `formatted_current_price` as strict nonnegative USD display money, with
  value source `clutchpacks_formatted_current_price`.

The outer `record_id` remains authoritative identity. Nested IDs, `name`,
`type`, `year`, `set`, card number, grading, certificate, owner, and all other
native fields remain protected provenance and cannot change canonical identity
or content.

## Historical pin boundary

Adapter v1 read ClutchPacks card display names only from top-level
`data.provider_label`; it did not expose `data.asset`. Existing connection,
source, cursor, run, and page rows pin that exact interpretation and therefore
must not be reinterpreted in place. Production registers only adapter v3; a
database containing adapter-v1 or adapter-v2 pins requires the guarded full
local reset and complete reimport. There is no fallback, compatibility adapter,
dual write, or generic provider branch.

The retired v2 canary executables and operator runbooks have been removed from
the active tree. Git history retains their audit record. Current operation uses
only the v3 clean-slate reset and reimport workflow. The v2 card interpretation
remains documented because it is the evidenced card-facts component reused by
the current v3 adapter; this document does not authorize running adapter v2.
