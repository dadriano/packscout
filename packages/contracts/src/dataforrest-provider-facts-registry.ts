import { clutchpacksCardProviderFacts } from
  "./dataforrest-clutchpacks-card-v2.ts";
import { clutchpacksPackProviderFacts } from
  "./dataforrest-clutchpacks-pack-v3.ts";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
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
] as const satisfies readonly ProviderFactsAdapter[]);

const supportedAdapterVersions: ReadonlySet<string> = new Set([
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
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
