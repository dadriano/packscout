import { clutchpacksCardProviderFacts } from
  "./dataforrest-clutchpacks-card-v2.ts";
import { clutchpacksPackProviderFacts } from
  "./dataforrest-clutchpacks-pack-v3.ts";
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
    adapterVersion: "dataforrest-events-adapter-v2",
    provider: "clutchpacks",
    kind: "card",
    read: clutchpacksCardProviderFacts,
  },
  {
    adapterVersion: "dataforrest-events-adapter-v3",
    provider: "clutchpacks",
    kind: "card",
    read: clutchpacksCardProviderFacts,
  },
  {
    adapterVersion: "dataforrest-events-adapter-v3",
    provider: "clutchpacks",
    kind: "pack",
    read: clutchpacksPackProviderFacts,
  },
] as const satisfies readonly ProviderFactsAdapter[]);

export function readDataforrestProviderFacts(
  adapterVersion: string,
  provider: LaunchProviderKey,
  kind: NormalizedProviderFacts["kind"],
  nativeData: Readonly<Record<string, unknown>>,
): NormalizedProviderFacts | null {
  const adapter = providerFactsAdapters.find(
    (candidate) =>
      candidate.adapterVersion === adapterVersion &&
      candidate.provider === provider &&
      candidate.kind === kind,
  ) as ProviderFactsAdapter | undefined;
  return adapter?.read(nativeData) ?? null;
}
