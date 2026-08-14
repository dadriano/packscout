export type AdminImportRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "incomplete"
  | "failed";

export type AdminImportTrigger = "scheduled" | "manual" | "recovery" | "archive";

export interface AdminProviderOperationRecord {
  readonly providerId: string;
  readonly platformKey: string;
  readonly configurationRevisionId: string;
  readonly configurationVersion: number;
}

export interface AdminProviderOperationCursor {
  readonly platformKey: string;
  readonly providerId: string;
}

export interface AdminRunOperationCursor {
  readonly requestedAt: Date;
  readonly runId: string;
}

export interface AdminImportRunCountersRecord {
  readonly pages: number;
  readonly catalog: number;
  readonly pulls: number;
  readonly trades: number;
  readonly accepted: number;
  readonly unchanged: number;
  readonly revised: number;
  readonly quarantined: number;
  readonly resolvedQuarantines: number;
}

export interface AdminImportPageRecord {
  readonly pageNumber: number;
  readonly requestedCursor: string | null;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly committedAt: Date;
  readonly catalog: number;
  readonly pulls: number;
  readonly trades: number;
  readonly accepted: number;
  readonly unchanged: number;
  readonly revised: number;
  readonly quarantined: number;
}

export interface AdminImportRunRecord {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly platformKey: string;
  readonly configurationRevisionId: string;
  readonly configurationVersion: number;
  readonly trigger: AdminImportTrigger;
  readonly state: AdminImportRunState;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly lastProgressAt: Date;
  readonly reachedProviderHead: boolean;
  readonly counters: AdminImportRunCountersRecord;
  readonly failureCode: string | null;
  readonly requestedCursor: string | null;
  readonly finalCursor: string | null;
  readonly pages: readonly AdminImportPageRecord[];
}

export interface AdminImportRunPage {
  readonly items: readonly AdminImportRunRecord[];
  readonly hasMore: boolean;
}
