import type { ProviderConfigurationSummary } from "@packscout/contracts";
import { requestJson } from "./client";

export interface ProviderHealthSummary {
  providerId: string;
  freshnessState: "fresh" | "stale";
  qualityState: "healthy" | "warning" | "degraded";
  activeRun: { id: string; state: "queued" | "running" } | null;
  latestRun: { id: string; state: string } | null;
  lastHeadReachedAt: string | null;
  nextDueAt: string | null;
  openQuarantineCount: number;
  consecutiveFailures: number;
  latestFailureClass: string | null;
  recoveryHint: string;
}

export interface ProviderAdminListItem {
  provider: ProviderConfigurationSummary;
  health: ProviderHealthSummary;
}

export function listProviders(): Promise<{ items: ProviderAdminListItem[] }> {
  return requestJson("/data-providers");
}

export function getProvider(providerId: string): Promise<ProviderAdminListItem> {
  return requestJson(`/data-providers/${encodeURIComponent(providerId)}`);
}
