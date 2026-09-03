/**
 * Production HTTP paths for the data_release_v3 publication lifecycle
 * (task buyback-adjusted-ev/008).
 *
 * These paths join the shared cross-version publication auth boundary in
 * `data-release-v2-publication-auth.ts`, so every request is signed, nonce
 * protected, and replay bounded exactly like the existing families.
 */
export const PRODUCTION_DATA_RELEASE_V3_PATHS = Object.freeze({
  activeState: "/internal/data-release/v3/active-state",
  retainedEvWitness: "/internal/data-release/v3/retained-ev-witness",
  start: "/internal/data-release/v3/start",
  applyBatch: "/internal/data-release/v3/apply-batch",
  finalize: "/internal/data-release/v3/finalize",
  activate: "/internal/data-release/v3/activate",
  rollback: "/internal/data-release/v3/rollback",
  status: "/internal/data-release/v3/status",
  refreshProviderObservation:
    "/internal/data-release/v3/refresh-provider-observation",
});

/**
 * data_release_v3 batches are packed deterministically by record count (32
 * full repack details or 100 records per batch), never re-split by bytes, so
 * the transport limit must admit the largest packing the entity schemas
 * allow. 512 KiB is the shared signed-HTTP client's ceiling; a batch beyond
 * it fails closed with PUBLICATION_BODY_TOO_LARGE before any staging write.
 */
export const MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES = 512 * 1_024;
