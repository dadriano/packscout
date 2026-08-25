import {
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestEventsV2SourceAdapterManifest,
  dataforrestEventsV3SourceAdapterManifest,
} from "@packscout/contracts";
import {
  DataforrestEventsSourceAdapter,
} from "./dataforrest-events-source-adapter.ts";
import { DataforrestEventsAdminConfigurationCodec } from "./dataforrest-events-admin-configuration-codec.ts";
import type { HardenedProviderRequestDependencies } from "./hardened-provider-request.ts";
import { SourceAdminConfigurationCodecRegistry } from "./source-admin-configuration-codec.ts";
import { SourceAdapterRegistry } from "./source-adapter-registry.ts";

export const productionSourceAdapterManifests = Object.freeze([
  dataforrestEventsV3SourceAdapterManifest,
]);

export function createProductionSourceAdapterRegistry(
  dependencies: HardenedProviderRequestDependencies = {},
): SourceAdapterRegistry {
  return new SourceAdapterRegistry(
    [
      new DataforrestEventsSourceAdapter(
        dependencies,
        dataforrestEventsV1SourceAdapterManifest,
      ),
      new DataforrestEventsSourceAdapter(
        dependencies,
        dataforrestEventsV2SourceAdapterManifest,
      ),
      new DataforrestEventsSourceAdapter(
        dependencies,
        dataforrestEventsV3SourceAdapterManifest,
      ),
    ],
    {
      [DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY]:
        DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
    },
  );
}

export function createProductionSourceAdminConfigurationCodecRegistry(
  sourceAdapters: SourceAdapterRegistry,
): SourceAdminConfigurationCodecRegistry {
  return new SourceAdminConfigurationCodecRegistry(
    [
      dataforrestEventsV1SourceAdapterManifest,
      dataforrestEventsV2SourceAdapterManifest,
      dataforrestEventsV3SourceAdapterManifest,
    ].map((manifest) =>
      new DataforrestEventsAdminConfigurationCodec(
        sourceAdapters.resolveSourceType(
          manifest.sourceTypeKey,
          manifest.adapterVersion,
        ),
      )
    ),
  );
}

export const productionSourceAdapterRegistry =
  createProductionSourceAdapterRegistry();
