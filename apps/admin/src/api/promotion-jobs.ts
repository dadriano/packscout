import type {
  PromotionJobHistoryPage,
  PromotionJobHistoryQuery,
  PromotionJobInvocationDetail,
  PromotionJobMonitoringOverview,
} from "@packscout/contracts";
import { requestJson } from "./client";

function queryString(query: PromotionJobHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.filter) params.set("filter", query.filter);
  if (query.trigger) params.set("trigger", query.trigger);
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit));
  return `?${params.toString()}`;
}

export function getPromotionJobOverview(
  signal?: AbortSignal,
): Promise<PromotionJobMonitoringOverview> {
  return requestJson("/promotion-jobs/overview", { signal });
}

export function listPromotionJobHistory(
  query: PromotionJobHistoryQuery,
  signal?: AbortSignal,
): Promise<PromotionJobHistoryPage> {
  return requestJson(`/promotion-jobs/history${queryString(query)}`, { signal });
}

export function getPromotionJobDetail(
  monitoringId: string,
  signal?: AbortSignal,
): Promise<PromotionJobInvocationDetail> {
  return requestJson(
    `/promotion-jobs/history/${encodeURIComponent(monitoringId)}`,
    { signal },
  );
}
