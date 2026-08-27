import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  dataforrestEventsV1LegacySourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
} from "@packscout/contracts";
import {
  DataforrestEventsSourceAdapter,
} from "./dataforrest-events-source-adapter.ts";
import { DataforrestEventsAdminConfigurationCodec } from "./dataforrest-events-admin-configuration-codec.ts";
import type { HardenedProviderRequestDependencies } from "./hardened-provider-request.ts";
import { SourceAdminConfigurationCodecRegistry } from "./source-admin-configuration-codec.ts";
import { SourceAdapterRegistry } from "./source-adapter-registry.ts";

const registeredProductionSourceAdapterManifests = Object.freeze([
  dataforrestEventsV1LegacySourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
]);

/** Safe catalog: only the version selectable for a new revision is advertised. */
export const productionSourceAdapterManifests = Object.freeze([
  dataforrestEventsV1SourceAdapterManifest,
]);

export function createProductionSourceAdapterRegistry(
  dependencies: HardenedProviderRequestDependencies = {},
): SourceAdapterRegistry {
  return new SourceAdapterRegistry(
    [
      new DataforrestEventsSourceAdapter(
        dependencies,
        dataforrestEventsV1LegacySourceAdapterManifest,
      ),
      new DataforrestEventsSourceAdapter(
        dependencies,
        dataforrestEventsV1SourceAdapterManifest,
      ),
    ],
    {
      [DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY]:
        DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    },
  );
}

export function createProductionSourceAdminConfigurationCodecRegistry(
  sourceAdapters: SourceAdapterRegistry,
): SourceAdminConfigurationCodecRegistry {
  return new SourceAdminConfigurationCodecRegistry(
    registeredProductionSourceAdapterManifests.map((manifest) =>
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
