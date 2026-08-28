import {
  dataforrestEventsV1SourceAdapterManifest,
} from "@packscout/contracts";
import {
  DataforrestEventsSourceAdapter,
} from "./dataforrest-events-source-adapter.ts";
import { DataforrestEventsAdminConfigurationCodec } from "./dataforrest-events-admin-configuration-codec.ts";
import type { HardenedProviderRequestDependencies } from "./hardened-provider-request.ts";
import { SourceAdminConfigurationCodecRegistry } from "./source-admin-configuration-codec.ts";
import { SourceAdapterRegistry } from "./source-adapter-registry.ts";

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
        dataforrestEventsV1SourceAdapterManifest,
      ),
    ],
  );
}

export function createProductionSourceAdminConfigurationCodecRegistry(
  sourceAdapters: SourceAdapterRegistry,
): SourceAdminConfigurationCodecRegistry {
  return new SourceAdminConfigurationCodecRegistry(
    [dataforrestEventsV1SourceAdapterManifest].map((manifest) =>
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
