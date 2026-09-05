export const DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION =
  "dataforrest-events-adapter-v1" as const;
export const DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION =
  "dataforrest-events-adapter-v2" as const;
export const DATAFORREST_EVENTS_V1_ADAPTER_VERSION =
  "dataforrest-events-adapter-v3" as const;
export const DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION =
  "dataforrest-clutchpacks-distributed-adapter-v1" as const;
export const DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION =
  "dataforrest-collector-crypt-distributed-adapter-v1" as const;
export const DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION =
  "dataforrest-collector-crypt-distributed-adapter-v2" as const;
/**
 * Distributed (all-stream) admission carrying BOTH the distributed-v2 card
 * reader and the reviewed native catalog-PACK interpretation. The catalog-only
 * v3 identity cannot serve production, which ingests pulls and trades from the
 * same source; adapter identities are immutable, so the pack reader arrives on
 * this new distributed identity rather than on distributed-v2.
 */
export const DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION =
  "dataforrest-collector-crypt-distributed-adapter-v3" as const;
/** Adds pack V2 probability-only EV evidence; every older identity is unchanged. */
export const DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V4_VERSION =
  "dataforrest-collector-crypt-distributed-adapter-v4" as const;
export const DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION =
  "dataforrest-collector-crypt-catalog-adapter-v1" as const;
export const DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION =
  "dataforrest-collector-crypt-catalog-adapter-v2" as const;
/**
 * Adds the reviewed native catalog-PACK interpretation. Catalog-v2 carried a
 * card reader only, so its packs stored hollow; adapter identities are
 * immutable admissions, so the pack reader arrives on this new identity.
 */
export const DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION =
  "dataforrest-collector-crypt-catalog-adapter-v3" as const;
export const DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION =
  "dataforrest-courtyard-distributed-adapter-v1" as const;
export const DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION =
  "dataforrest-courtyard-distributed-adapter-v2" as const;
/**
 * Distributed (all-stream) admission carrying BOTH the distributed-v2 card
 * reader and the reviewed native catalog-PACK interpretation, on distributed-v2's
 * exact transport admissions. Courtyard packs otherwise fall back to the
 * provider-declared display-name field and are rejected outright.
 */
export const DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION =
  "dataforrest-courtyard-distributed-adapter-v3" as const;
/** Adds pack V2 probability-only EV evidence; every older identity is unchanged. */
export const DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V4_VERSION =
  "dataforrest-courtyard-distributed-adapter-v4" as const;
export const DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION =
  "dataforrest-courtyard-catalog-adapter-v1" as const;
/**
 * Adds the reviewed native catalog-PACK interpretation. Catalog-v1 carried a
 * card reader only, so its packs fell back to Courtyard's provider-declared
 * display-name field and were rejected outright.
 */
export const DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION =
  "dataforrest-courtyard-catalog-adapter-v2" as const;
export const DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION =
  "dataforrest-launch-distributed-adapter-v1" as const;
export const DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION =
  "dataforrest-phygitals-distributed-adapter-v1" as const;
export const DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION =
  "dataforrest-phygitals-distributed-adapter-v2" as const;
/**
 * Distributed (all-stream) admission carrying BOTH the distributed-v2 card
 * reader and the reviewed native catalog-PACK interpretation. Distributed-v2
 * stored its packs hollow.
 */
export const DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION =
  "dataforrest-phygitals-distributed-adapter-v3" as const;
/**
 * Distributed (all-stream) admission carrying the distributed-v2 card reader
 * and the catalog-PACK reader V2, which binds the published rarity
 * distribution as a probability-only EV input (odds plus a USD value range per
 * tier, pool size unknown). Distributed-v3 left `evInput` absent.
 */
export const DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION =
  "dataforrest-phygitals-distributed-adapter-v4" as const;
export const DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION =
  "dataforrest-phygitals-catalog-adapter-v1" as const;
/**
 * Adds the reviewed native catalog-PACK interpretation. Catalog-v1 carried a
 * card reader only, so its packs stored hollow.
 */
export const DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION =
  "dataforrest-phygitals-catalog-adapter-v2" as const;
