import type {
  CreateProviderRequest,
  ProviderConfigurationSummary,
  ProviderConnectionTestSummary,
  ReplaceProviderRevisionRequest,
} from "@packscout/contracts";
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

export function createProvider(
  input: CreateProviderRequest,
): Promise<{ provider: ProviderConfigurationSummary }> {
  return requestJson("/data-providers", { method: "POST", json: input });
}

export function replaceProviderRevision(
  providerId: string,
  input: ReplaceProviderRevisionRequest,
): Promise<{ provider: ProviderConfigurationSummary }> {
  return requestJson(`/data-providers/${encodeURIComponent(providerId)}/revisions`, {
    method: "POST",
    json: input,
  });
}

export function testProviderConnection(
  providerId: string,
  revisionId: string,
): Promise<{ test: ProviderConnectionTestSummary }> {
  return requestJson(
    `/data-providers/${encodeURIComponent(providerId)}/revisions/${encodeURIComponent(revisionId)}/test`,
    { method: "POST" },
  );
}

export function changeProviderLifecycle(
  providerId: string,
  action: "activate" | "disable" | "archive",
  expectedRevisionId: string,
): Promise<{ provider: ProviderConfigurationSummary }> {
  const encodedProviderId = encodeURIComponent(providerId);
  const path = action === "activate"
    ? `/data-providers/${encodedProviderId}/revisions/${encodeURIComponent(expectedRevisionId)}/activate`
    : `/data-providers/${encodedProviderId}/${action}`;
  return requestJson(path, {
    method: "POST",
    ...(action === "activate" ? {} : { json: { expectedRevisionId } }),
  });
}
