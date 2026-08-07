import { ProviderMappingAdapterRegistry } from "../provider-adapter-registry.ts";
import type {
  ProviderMappingAdapter,
  ProviderRecordKind,
} from "../provider-adapter.ts";
import {
  beezieProviderMappingAdapter,
  BEEZIE_SOURCE_SHA256,
} from "./beezie/mapper.ts";
import {
  clutchpacksProviderMappingAdapter,
  CLUTCHPACKS_SOURCE_SHA256,
} from "./clutchpacks/mapper.ts";
import { CollectorCryptMappingAdapter } from "./collector-crypt/mapper.ts";
import { CourtyardMappingAdapter } from "./courtyard/mapper.ts";
import { GameStopMappingAdapter } from "./gamestop/mapper.ts";
import { PhygitalsMappingAdapter } from "./phygitals/mapper.ts";
import { StadiumVaultMappingAdapter } from "./stadium-vault/mapper.ts";
import { TroveMappingAdapter } from "./trove/mapper.ts";

export const collectorCryptProviderMappingAdapter =
  new CollectorCryptMappingAdapter();
export const courtyardProviderMappingAdapter = new CourtyardMappingAdapter();
export const gameStopProviderMappingAdapter = new GameStopMappingAdapter();
export const phygitalsProviderMappingAdapter = new PhygitalsMappingAdapter();
export const stadiumVaultProviderMappingAdapter =
  new StadiumVaultMappingAdapter();
export const troveProviderMappingAdapter = new TroveMappingAdapter();

export interface ProviderMapperManifestEntry {
  readonly platformKey: string;
  readonly adapterKey: string;
  readonly mappingVersion: string;
  readonly sourceContract: Readonly<{
    sha256: string;
    observedRecordCounts: Readonly<Record<ProviderRecordKind, number>>;
  }>;
  readonly adapter: ProviderMappingAdapter;
}

export const providerMapperManifest: readonly ProviderMapperManifestEntry[] =
  Object.freeze([
    Object.freeze({
      platformKey: beezieProviderMappingAdapter.platformKey,
      adapterKey: beezieProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: BEEZIE_SOURCE_SHA256,
        observedRecordCounts: Object.freeze({
          catalog: 4,
          pull: 15,
          sale: 15,
        }),
      }),
      adapter: beezieProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: clutchpacksProviderMappingAdapter.platformKey,
      adapterKey: clutchpacksProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: CLUTCHPACKS_SOURCE_SHA256,
        observedRecordCounts: Object.freeze({
          catalog: 14,
          pull: 15,
          sale: 15,
        }),
      }),
      adapter: clutchpacksProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: collectorCryptProviderMappingAdapter.platformKey,
      adapterKey: collectorCryptProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: "2e3eddcccc5aa1dbe6c435bae7f17e6d08811eff418104b2d1ed26ed0eb84064",
        observedRecordCounts: Object.freeze({
          catalog: 14,
          pull: 15,
          sale: 15,
        }),
      }),
      adapter: collectorCryptProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: courtyardProviderMappingAdapter.platformKey,
      adapterKey: courtyardProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: "20021fca6c69d10f539788e11e8ed41aad835fd7e4de6d52ce7119c6d477ecd7",
        observedRecordCounts: Object.freeze({
          catalog: 11,
          pull: 15,
          sale: 15,
        }),
      }),
      adapter: courtyardProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: gameStopProviderMappingAdapter.platformKey,
      adapterKey: gameStopProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: "06ef8dda43b26095b11b430e814f4a3b7a1e727bdca0ecf47354cef1ee93bb4f",
        observedRecordCounts: Object.freeze({
          catalog: 8,
          pull: 15,
          sale: 0,
        }),
      }),
      adapter: gameStopProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: phygitalsProviderMappingAdapter.platformKey,
      adapterKey: phygitalsProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: "3620d97462090454c8cc1867a408255445a3219fe0917ac2a4b8cc5973bb8c23",
        observedRecordCounts: Object.freeze({
          catalog: 15,
          pull: 15,
          sale: 15,
        }),
      }),
      adapter: phygitalsProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: stadiumVaultProviderMappingAdapter.platformKey,
      adapterKey: stadiumVaultProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: "fe5c90c64f48b18ecfc5d6863c8f3b2e11d1fae5764dfa773531c59d8efc026a",
        observedRecordCounts: Object.freeze({
          catalog: 14,
          pull: 15,
          sale: 0,
        }),
      }),
      adapter: stadiumVaultProviderMappingAdapter,
    }),
    Object.freeze({
      platformKey: troveProviderMappingAdapter.platformKey,
      adapterKey: troveProviderMappingAdapter.key,
      mappingVersion: "v1",
      sourceContract: Object.freeze({
        sha256: "cadc01c597744075ca8f0be891672d288df013dd8e61f182647614ce20b50a3b",
        observedRecordCounts: Object.freeze({
          catalog: 15,
          pull: 15,
          sale: 0,
        }),
      }),
      adapter: troveProviderMappingAdapter,
    }),
  ]);

export function createProviderMappingAdapterRegistryFromManifest() {
  return new ProviderMappingAdapterRegistry(
    providerMapperManifest.map((entry) => entry.adapter),
  );
}
