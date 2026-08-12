import type {
  CreateOperatorRequest,
  OperatorListResponse,
  OperatorMutationResponse,
  OperatorRole,
  OperatorState,
  UpdateOperatorRequest,
} from "@packscout/contracts";
import { requestJson, type Fetcher } from "./client";

export interface OperatorListFilters {
  cursor?: string;
  limit?: number;
  search?: string;
  role?: OperatorRole;
  state?: OperatorState;
}

export function listOperators(
  filters: OperatorListFilters = {},
  signal?: AbortSignal,
  fetcher?: Fetcher,
): Promise<OperatorListResponse> {
  const query = new URLSearchParams();
  if (filters.cursor) query.set("cursor", filters.cursor);
  if (filters.limit !== undefined) query.set("limit", String(filters.limit));
  if (filters.search) query.set("search", filters.search);
  if (filters.role) query.set("role", filters.role);
  if (filters.state) query.set("state", filters.state);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson<OperatorListResponse>(
    `/operators${suffix}`,
    { signal },
    fetcher,
  );
}

export function createOperator(
  input: CreateOperatorRequest,
  fetcher?: Fetcher,
): Promise<OperatorMutationResponse> {
  return requestJson<OperatorMutationResponse>(
    "/operators",
    { method: "POST", json: input },
    fetcher,
  );
}

export function updateOperator(
  operatorId: string,
  input: UpdateOperatorRequest,
  fetcher?: Fetcher,
): Promise<OperatorMutationResponse> {
  return requestJson<OperatorMutationResponse>(
    `/operators/${encodeURIComponent(operatorId)}`,
    { method: "PATCH", json: input },
    fetcher,
  );
}
