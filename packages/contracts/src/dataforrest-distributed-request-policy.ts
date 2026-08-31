import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
} from "./dataforrest-events-v1.ts";
import { z } from "zod";
import { providerSourceRecordsPerRequest, providerSourceRecordsPerRequestSchema } from "./provider-source-contract-v1.ts";

/** A current isolated run must carry both parts of its immutable request pin. */
export const dataforrestDistributedRunRequestPinSchema = z.object({
  recordsPerRequest: providerSourceRecordsPerRequestSchema,
  requestSettingsRevisionId: z.string().uuid(),
}).strict();

/**
 * Historical manifests retain their original request default. Only the
 * isolated import executor may opt into this independently pinned capacity;
 * neither an adapter identity nor a mutable setting rewrites an old run.
 */
const distributedManifests = [
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
] as const;

export interface DataforrestDistributedRequestPolicy {
  readonly defaultRecordsPerRequest: number;
  readonly maximumRecordsPerRequest: number;
  readonly maximumResponseBytes: number;
  readonly timeoutMilliseconds: number;
}

/** Closed adapter/provider capability; unknown and shared-source versions refuse. */
export function dataforrestDistributedRequestPolicy(
  adapterKey: string,
  providerKey: string,
): DataforrestDistributedRequestPolicy | null {
  const manifest = distributedManifests.find((candidate) =>
    candidate.adapterVersion === adapterKey &&
    candidate.supportedProviders.some(({ provider }) => provider === providerKey)
  );
  return manifest === undefined ? null : Object.freeze({
    defaultRecordsPerRequest: manifest.requestBounds.pageLimit,
    maximumRecordsPerRequest: providerSourceRecordsPerRequest.maximum,
    maximumResponseBytes: manifest.requestBounds.maximumResponseBytes,
    timeoutMilliseconds: manifest.requestBounds.timeoutMilliseconds,
  });
}
