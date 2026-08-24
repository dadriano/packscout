import type {
  ProviderSourceDiagnosticFilter,
  ProviderSourceDiagnosticHistory,
  ProviderSourceOperationsDetail,
  ProviderSourceOperationsOverview,
} from "@packscout/contracts";
import { requestJson } from "./client";

function queryString(input: Readonly<{
  filter?: ProviderSourceDiagnosticFilter;
  cursor?: string;
  limit?: number;
}>): string {
  const query = new URLSearchParams();
  if (input.filter?.severity) query.set("severity", input.filter.severity);
  if (input.filter?.phase) query.set("phase", input.filter.phase);
  if (input.filter?.runId) query.set("runId", input.filter.runId);
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function getProviderSourceOperationsOverview(): Promise<
  ProviderSourceOperationsOverview
> {
  return requestJson("/provider-source-operations");
}

export function getProviderSourceOperationsDetail(
  providerId: string,
): Promise<ProviderSourceOperationsDetail> {
  return requestJson(
    `/provider-source-operations/providers/${encodeURIComponent(providerId)}`,
  );
}

export function getProviderSourceDiagnostics(
  providerId: string,
  input: Readonly<{
    filter?: ProviderSourceDiagnosticFilter;
    cursor?: string;
    limit?: number;
  }> = {},
): Promise<ProviderSourceDiagnosticHistory> {
  return requestJson(
    `/provider-source-operations/providers/${encodeURIComponent(providerId)}/diagnostics${queryString(input)}`,
  );
}
