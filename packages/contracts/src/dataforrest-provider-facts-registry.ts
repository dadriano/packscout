import { clutchpacksCardProviderFacts } from
  "./dataforrest-clutchpacks-card-v2.ts";
import { clutchpacksPackProviderFacts } from
  "./dataforrest-clutchpacks-pack-v3.ts";
import { collectorCryptCardProviderFactsV1 } from
  "./dataforrest-collector-crypt-card-v1.ts";
import { collectorCryptPackProviderFactsV1 } from
  "./dataforrest-collector-crypt-pack-v1.ts";
import { phygitalsCardProviderFactsV1 } from
  "./dataforrest-phygitals-card-v1.ts";
import { phygitalsCardProviderFactsV2 } from
  "./dataforrest-phygitals-card-v2.ts";
import { phygitalsPackProviderFactsV1 } from
  "./dataforrest-phygitals-pack-v1.ts";
import { phygitalsPackProviderFactsV2 } from
  "./dataforrest-phygitals-pack-v2.ts";
import { courtyardCardProviderFactsV1 } from
  "./dataforrest-courtyard-card-v1.ts";
import { courtyardPackProviderFactsV1 } from
  "./dataforrest-courtyard-pack-v1.ts";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
} from "./dataforrest-events-v1-adapter-versions.ts";
import type { LaunchProviderKey } from "./provider-source-contract-v1.ts";
import type { NormalizedProviderFacts } from "./provider-source-facts-v1.ts";

type ProviderFactsAdapter = Readonly<{
  adapterVersion: string;
  provider: LaunchProviderKey;
  kind: NormalizedProviderFacts["kind"];
  read(nativeData: Readonly<Record<string, unknown>>): NormalizedProviderFacts;
}>;

/**
 * Provider-specific native interpretation belongs behind this registry. The
 * generic DataForrest envelope normalizer performs exact dispatch and otherwise
 * falls back to its provider-declared display-name field only.
 */
const providerFactsAdapters = Object.freeze([
  {
    adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
    provider: "clutchpacks",
    kind: "card",
    read: clutchpacksCardProviderFacts,
  },
  {
    adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    provider: "clutchpacks",
    kind: "card",
    read: clutchpacksCardProviderFacts,
  },
  {
    adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    provider: "clutchpacks",
    kind: "pack",
    read: clutchpacksPackProviderFacts,
  },
  {
    adapterVersion: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    provider: "clutchpacks",
    kind: "card",
    read: clutchpacksCardProviderFacts,
  },
  {
    adapterVersion: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    provider: "clutchpacks",
    kind: "pack",
    read: clutchpacksPackProviderFacts,
  },
  {
    adapterVersion: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
    provider: "collector_crypt",
    kind: "card",
    read: collectorCryptCardProviderFactsV1,
  },
  // Distributed-v3 is the all-stream identity that carries the native pack
  // reader. The catalog-scoped v3 identity cannot serve a production source,
  // which ingests pulls and trades from the same configuration.
  {
    adapterVersion: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
    provider: "collector_crypt",
    kind: "card",
    read: collectorCryptCardProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
    provider: "collector_crypt",
    kind: "pack",
    read: collectorCryptPackProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
    provider: "collector_crypt",
    kind: "card",
    read: collectorCryptCardProviderFactsV1,
  },
  // Catalog-v3 adds the native pack reader. The catalog-v2 card interpretation
  // is carried forward unchanged so a source pinned to v3 reads both entities.
  {
    adapterVersion: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
    provider: "collector_crypt",
    kind: "card",
    read: collectorCryptCardProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
    provider: "collector_crypt",
    kind: "pack",
    read: collectorCryptPackProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
    provider: "courtyard",
    kind: "card",
    read: courtyardCardProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
    provider: "courtyard",
    kind: "card",
    read: courtyardCardProviderFactsV1,
  },
  // Distributed-v3 carries the distributed-v2 card interpretation forward and
  // adds the native pack reader, so an all-stream Courtyard source reads both
  // entities instead of rejecting every pack on the display-name fallback.
  {
    adapterVersion: DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
    provider: "courtyard",
    kind: "card",
    read: courtyardCardProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
    provider: "courtyard",
    kind: "pack",
    read: courtyardPackProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
    provider: "courtyard",
    kind: "card",
    read: courtyardCardProviderFactsV1,
  },
  // Catalog-v2 adds the native pack reader. Without it Courtyard packs fell
  // through to the provider-declared display-name field (`provider_label`),
  // which no observed Courtyard pack payload carries.
  {
    adapterVersion: DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
    provider: "courtyard",
    kind: "card",
    read: courtyardCardProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
    provider: "courtyard",
    kind: "pack",
    read: courtyardPackProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
    provider: "phygitals",
    kind: "card",
    read: phygitalsCardProviderFactsV1,
  },
  {
    adapterVersion: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
    provider: "phygitals",
    kind: "card",
    read: phygitalsCardProviderFactsV2,
  },
  // Distributed-v3 carries the distributed-v2 card interpretation forward and
  // adds the native pack reader; distributed-v2 stored its packs hollow.
  {
    adapterVersion: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
    provider: "phygitals",
    kind: "card",
    read: phygitalsCardProviderFactsV2,
  },
  {
    adapterVersion: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
    provider: "phygitals",
    kind: "pack",
    read: phygitalsPackProviderFactsV1,
  },
  // Distributed-v4 carries the distributed-v2 card interpretation forward and
  // the pack reader V2, which binds the published rarity distribution as a
  // probability-only EV input; distributed-v3 left evInput absent.
  {
    adapterVersion: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
    provider: "phygitals",
    kind: "card",
    read: phygitalsCardProviderFactsV2,
  },
  {
    adapterVersion: DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
    provider: "phygitals",
    kind: "pack",
    read: phygitalsPackProviderFactsV2,
  },
  {
    adapterVersion: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
    provider: "phygitals",
    kind: "card",
    read: phygitalsCardProviderFactsV2,
  },
  // Catalog-v2 adds the native pack reader and carries the catalog-v1 card
  // interpretation (phygitals card V2) forward unchanged.
  {
    adapterVersion: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
    provider: "phygitals",
    kind: "card",
    read: phygitalsCardProviderFactsV2,
  },
  {
    adapterVersion: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
    provider: "phygitals",
    kind: "pack",
    read: phygitalsPackProviderFactsV1,
  },
] as const satisfies readonly ProviderFactsAdapter[]);

const supportedAdapterVersions: ReadonlySet<string> = new Set([
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
]);

export function readDataforrestProviderFacts(
  adapterVersion: string,
  provider: LaunchProviderKey,
  kind: NormalizedProviderFacts["kind"],
  nativeData: Readonly<Record<string, unknown>>,
): NormalizedProviderFacts | null {
  if (!supportedAdapterVersions.has(adapterVersion)) {
    throw new RangeError("dataforrest_events.adapter_version_unsupported");
  }
  const adapter = providerFactsAdapters.find(
    (candidate) =>
      candidate.adapterVersion === adapterVersion &&
      candidate.provider === provider &&
      candidate.kind === kind,
  ) as ProviderFactsAdapter | undefined;
  return adapter?.read(nativeData) ?? null;
}
