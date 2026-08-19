import { ProviderMappingAdapterRegistry } from "../provider-adapter-registry.ts";
import type {
  ProviderMappingAdapter,
  ProviderRecordKind,
} from "../provider-adapter.ts";
import { ClutchpacksMappingAdapter } from "./clutchpacks/mapper.ts";
import { CollectorCryptMappingAdapter } from "./collector-crypt/mapper.ts";
import { CourtyardMappingAdapter } from "./courtyard/mapper.ts";
import { PhygitalsMappingAdapter } from "./phygitals/mapper.ts";

export const collectorCryptProviderMappingAdapter =
  new CollectorCryptMappingAdapter();
export const clutchpacksProviderMappingAdapter =
  new ClutchpacksMappingAdapter();
export const courtyardProviderMappingAdapter = new CourtyardMappingAdapter();
export const phygitalsProviderMappingAdapter = new PhygitalsMappingAdapter();

export interface ProviderMapperManifestEntry {
  readonly platformKey: string;
  readonly adapterKey: string;
  readonly mappingVersion: "v2";
  readonly supportedRecordKinds: readonly ProviderRecordKind[];
  readonly adapter: ProviderMappingAdapter;
}

const v2RecordKinds = Object.freeze([
  "catalog",
  "pull",
  "trade",
] as const satisfies readonly ProviderRecordKind[]);

export const providerMapperManifest: readonly ProviderMapperManifestEntry[] =
  Object.freeze([
    Object.freeze({
      platformKey: collectorCryptProviderMappingAdapter.platformKey,
      adapterKey: collectorCryptProviderMappingAdapter.key,
      mappingVersion: "v2",
      supportedRecordKinds: v2RecordKinds,
      adapter: collectorCryptProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: clutchpacksProviderMappingAdapter.platformKey,
      adapterKey: clutchpacksProviderMappingAdapter.key,
      mappingVersion: "v2",
      supportedRecordKinds: v2RecordKinds,
      adapter: clutchpacksProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: courtyardProviderMappingAdapter.platformKey,
      adapterKey: courtyardProviderMappingAdapter.key,
      mappingVersion: "v2",
      supportedRecordKinds: v2RecordKinds,
      adapter: courtyardProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: phygitalsProviderMappingAdapter.platformKey,
      adapterKey: phygitalsProviderMappingAdapter.key,
      mappingVersion: "v2",
      supportedRecordKinds: v2RecordKinds,
      adapter: phygitalsProviderMappingAdapter,
    }),
  ]);

export function createProviderMappingAdapterRegistryFromManifest() {
  return new ProviderMappingAdapterRegistry(
    providerMapperManifest.map((entry) => entry.adapter),
  );
}
