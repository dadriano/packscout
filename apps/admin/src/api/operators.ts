import type {
  DirectProvisionOperatorRequest,
  DirectProvisionOperatorResponse,
  InviteOperatorRequest,
  OperatorInvitationStatus,
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

/**
 * Creates an operator by invitation: an address, a name, and a role, and no
 * password. The single-use link is mailed by the server; nothing about it
 * ever reaches the browser.
 */
export function inviteOperator(
  input: InviteOperatorRequest,
  fetcher?: Fetcher,
): Promise<OperatorMutationResponse> {
  return requestJson<OperatorMutationResponse>(
    "/operators",
    { method: "POST", json: input },
    fetcher,
  );
}

/**
 * Creates an active operator with an administrator-supplied initial password.
 * The server never returns the password and reports email enqueueing as a
 * separate outcome after the account has committed.
 */
export function createOperatorWithPassword(
  input: DirectProvisionOperatorRequest,
  fetcher?: Fetcher,
): Promise<DirectProvisionOperatorResponse> {
  return requestJson<DirectProvisionOperatorResponse>(
    "/operators/direct",
    { method: "POST", json: input },
    fetcher,
  );
}

/** Sends a fresh invitation, which supersedes any outstanding one. */
export function reissueOperatorInvitation(
  operatorId: string,
  fetcher?: Fetcher,
): Promise<{ invitation: OperatorInvitationStatus }> {
  return requestJson<{ invitation: OperatorInvitationStatus }>(
    `/operators/${encodeURIComponent(operatorId)}/invitation`,
    { method: "POST" },
    fetcher,
  );
}

/** Withdraws a pending account and invalidates its outstanding invitation. */
export function cancelOperatorInvitation(
  operatorId: string,
  fetcher?: Fetcher,
): Promise<OperatorMutationResponse> {
  return requestJson<OperatorMutationResponse>(
    `/operators/${encodeURIComponent(operatorId)}/invitation`,
    { method: "DELETE" },
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
