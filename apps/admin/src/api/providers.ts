import type { ProviderSourceRootSummary } from "@packscout/contracts";
import { requestJson } from "./client";

export function listProviders(): Promise<{ items: ProviderSourceRootSummary[] }> {
  return requestJson("/data-providers");
}

export function getProvider(
  providerId: string,
): Promise<{ provider: ProviderSourceRootSummary }> {
  return requestJson(`/data-providers/${encodeURIComponent(providerId)}`);
}
