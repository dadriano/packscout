import type {
  ImportRunDetailLocation,
  QuarantineEntryDetail,
  QuarantineEntrySummary,
  QuarantineRetryOutcome,
} from "@packscout/contracts";
import { requestJson } from "./client";

export type ImportRunState = "queued" | "running" | "succeeded" | "incomplete" | "failed";
export type ImportRunTrigger = "scheduled" | "manual" | "continuation" | "recovery";

export interface ImportRunCounters {
  pages: number;
  catalog: number;
  pulls: number;
  trades: number;
  accepted: number;
  unchanged: number;
  revised: number | null;
  quarantined: number;
  resolvedQuarantines: number;
}

export interface ImportRunSummary {
  id: string;
  providerId: string;
  providerName: string;
  platformKey: string;
  configurationRevisionId: string;
  configurationVersion: number;
  trigger: ImportRunTrigger;
  state: ImportRunState;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastProgressAt: string | null;
  reachedProviderHead: boolean;
  counters: ImportRunCounters;
  failure: { class: string; code: string; summary: string } | null;
}

export interface ImportRunDetail extends ImportRunSummary {
  cursor: { requestedPreview: string | null; finalPreview: string | null };
  pages: Array<{
    pageNumber: number;
    requestedCursorPreview: string | null;
    nextCursorPreview: string | null;
    hasMore: boolean;
    committedAt: string;
    catalog: number;
    pulls: number;
    trades: number;
    accepted: number;
    unchanged: number;
    revised: number | null;
    quarantined: number;
  }>;
  timeline: Array<{ state: ImportRunState; occurredAt: string; summary: string }>;
  relatedQuarantines: QuarantineEntrySummary[];
}

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
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

export function listImportRuns(query: PageQuery & {
  providerId?: string;
  state?: ImportRunState;
  trigger?: ImportRunTrigger;
} = {}): Promise<PageResponse<ImportRunSummary>> {
  return requestJson(`/import-runs${queryString(query)}`);
}

export function getImportRun(
  location: ImportRunDetailLocation,
): Promise<{ run: ImportRunDetail }> {
  return requestJson(`/import-runs/${encodeURIComponent(location.runId)}${
    queryString({ providerId: location.providerId })
  }`);
}

export function requestManualImport(
  providerId: string,
  expectedSourceRevisionId: string,
): Promise<{
  run: Pick<ImportRunSummary, "id" | "providerId" | "configurationRevisionId" | "trigger" | "state">;
  deduplicated: boolean;
  outcome: "queued" | "coalesced";
}> {
  return requestJson(`/data-providers/${encodeURIComponent(providerId)}/import-runs`, {
    method: "POST",
    json: { expectedSourceRevisionId },
  });
}

export function listQuarantines(query: PageQuery & {
  providerId?: string;
  runId?: string;
  state?: QuarantineEntrySummary["state"];
  recordKind?: QuarantineEntrySummary["recordKind"];
  reasonCode?: string;
} = {}): Promise<PageResponse<QuarantineEntrySummary>> {
  return requestJson(`/quarantine${queryString(query)}`);
}

export function getQuarantineEntry(
  quarantineId: string,
): Promise<{ entry: QuarantineEntryDetail }> {
  return requestJson(`/quarantine/${encodeURIComponent(quarantineId)}`);
}

export function retryQuarantine(
  quarantineId: string,
): Promise<{ outcome: QuarantineRetryOutcome }> {
  return requestJson(`/quarantine/${encodeURIComponent(quarantineId)}/retries`, {
    method: "POST",
  });
}

export function retryQuarantines(
  quarantineIds: string[],
): Promise<{ outcomes: QuarantineRetryOutcome[] }> {
  return requestJson("/quarantine/retries", {
    method: "POST",
    json: { quarantineIds },
  });
}
