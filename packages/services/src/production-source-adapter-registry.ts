import { dataforrestEventsV1SourceAdapterManifest } from "@packscout/contracts";
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
  return new SourceAdapterRegistry([
    new DataforrestEventsSourceAdapter(dependencies),
  ]);
}

export function createProductionSourceAdminConfigurationCodecRegistry(
  sourceAdapters: SourceAdapterRegistry,
): SourceAdminConfigurationCodecRegistry {
  const adapter = sourceAdapters.resolveOnlyVersion(
    dataforrestEventsV1SourceAdapterManifest.sourceTypeKey,
  );
  return new SourceAdminConfigurationCodecRegistry([
    new DataforrestEventsAdminConfigurationCodec(adapter),
  ]);
}

export const productionSourceAdapterRegistry =
  createProductionSourceAdapterRegistry();
