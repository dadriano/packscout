import type {
  RecomputationBacklogEvaluation,
  RecomputationQueueEntry,
  RecomputationQueueState,
  RecomputationRecoveryAction,
  RecomputationRecoveryResult,
  RetentionCadenceEvaluation,
  RetentionExecutionSummary,
} from "@packscout/contracts";
import { requestJson } from "./client";

export interface RecomputationQueuePage {
  items: RecomputationQueueEntry[];
  nextCursor: string | null;
  backlog: RecomputationBacklogEvaluation;
}

export interface RetentionExecutionPage {
  items: RetentionExecutionSummary[];
  nextCursor: string | null;
  cadence: RetentionCadenceEvaluation;
}

interface PageQuery {
  cursor?: string;
  limit?: number;
}

function queryString<T extends object>(values: T): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function listRecomputations(
  query: PageQuery & { state?: RecomputationQueueState } = {},
): Promise<RecomputationQueuePage> {
  return requestJson(`/background-work/recomputations${queryString(query)}`);
}

export function listRetentionExecutions(
  query: PageQuery = {},
): Promise<RetentionExecutionPage> {
  return requestJson(
    `/background-work/retention-executions${queryString(query)}`,
  );
}

export function recoverRecomputation(
  requestId: string,
  action: RecomputationRecoveryAction,
): Promise<{ result: RecomputationRecoveryResult }> {
  return requestJson(
    `/background-work/recomputations/${encodeURIComponent(requestId)}/recoveries`,
    { method: "POST", json: { action } },
  );
}

export function recoverRecomputations(
  requestIds: string[],
  action: RecomputationRecoveryAction,
): Promise<{ results: RecomputationRecoveryResult[] }> {
  return requestJson("/background-work/recomputations/recoveries", {
    method: "POST",
    json: { action, requestIds },
  });
}
