import type {
  AdminAlertDetail,
  AdminAlertState,
  AdminAlertSummary,
} from "@packscout/contracts";
import { requestJson } from "./client";

export function listOperationalAlerts(input: {
  state?: AdminAlertState;
  limit?: number;
} = {}): Promise<{ items: AdminAlertSummary[] }> {
  const query = new URLSearchParams();
  if (input.state) query.set("state", input.state);
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson(`/operational-alerts${suffix}`);
}

export function getOperationalAlert(
  alertId: string,
): Promise<{ alert: AdminAlertDetail }> {
  return requestJson(`/operational-alerts/${encodeURIComponent(alertId)}`);
}

export function acknowledgeOperationalAlert(
  alertId: string,
): Promise<{ alert: AdminAlertSummary }> {
  return requestJson(
    `/operational-alerts/${encodeURIComponent(alertId)}/acknowledge`,
    { method: "POST" },
  );
}

export function resolveOperationalAlert(
  alertId: string,
): Promise<{ alert: AdminAlertSummary }> {
  return requestJson(
    `/operational-alerts/${encodeURIComponent(alertId)}/resolve`,
    { method: "POST" },
  );
}
