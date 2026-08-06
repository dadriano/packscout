import { requestJson, type Fetcher } from "./client";

export interface AdminHealth {
  ok: true;
  service: "packscout-admin";
}

export function getAdminHealth(signal?: AbortSignal, fetcher?: Fetcher) {
  return requestJson<AdminHealth>("/health", { signal }, fetcher);
}
