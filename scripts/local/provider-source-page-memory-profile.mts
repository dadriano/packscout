import { dataforrestEventsV1SourceAdapterManifest, dataforrestCourtyardDistributedV2SourceAdapterManifest,
  DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES, providerSourceLaunchBounds } from "@packscout/contracts";

/** Fixed synthetic capacity witnesses only. No URL, credential, node/byte limit, or concurrency overrides. */
export function providerSourceMemoryProfile(args: readonly string[]) {
  if (args.length === 0) return Object.freeze({ name: "historical", manifest: dataforrestEventsV1SourceAdapterManifest,
    concurrentPages: 4, warmupPageCount: 12, trialCount: 5, pagesPerTrial: 20,
    recordsPerPage: providerSourceLaunchBounds.pageTargetRecords, emptyObjectFactsPerRecord: 945,
    nativeNodeTarget: null });
  if (args.length !== 2 || args[0] !== "--profile" || !["courtyard-v2-wide", "courtyard-v2-distributed"].includes(args[1] ?? "")) {
    throw new Error("PROVIDER_SOURCE_MEMORY_PROFILE_INVALID");
  }
  return Object.freeze({ name: args[1]!, manifest: dataforrestCourtyardDistributedV2SourceAdapterManifest,
    concurrentPages: 1, warmupPageCount: 4, trialCount: 3, pagesPerTrial: 4,
    recordsPerPage: args[1] === "courtyard-v2-wide" ? 1 : 100, emptyObjectFactsPerRecord: 0,
    nativeNodeTarget: DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES });
}
