export const sourceRecordKinds = ["catalog", "pull", "trade"] as const;
export type SourceRecordKind = (typeof sourceRecordKinds)[number];

export const canonicalRecordKinds = [
  "platform",
  "pack",
  "catalog_asset",
  "ev_input",
  "pull",
  "trade",
  "estimated_ev",
] as const;
export type CanonicalRecordKind = (typeof canonicalRecordKinds)[number];

export interface RunCounters {
  accepted: number;
  duplicate: number;
  quarantined: number;
  pages: number;
  records: number;
  requestAttempts: number;
  transientRetries: number;
}

export interface RecordCounts {
  catalog: number;
  pulls: number;
  trades: number;
}

export interface CanonicalIdentity {
  platformKey: string;
  recordKind: CanonicalRecordKind;
  externalId: string;
}

export interface RelationshipInput {
  relationshipKind: string;
  targetPlatformKey: string;
  targetRecordKind: CanonicalRecordKind;
  targetExternalId: string | null;
}

export interface CanonicalProjectionInput extends CanonicalIdentity {
  content: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  sourceUpdatedAt: Date;
  sourceCollectedAt: Date;
  sourceActorIdentifier?: string;
  relationships?: readonly RelationshipInput[];
}

export interface AcceptedSourceRecordInput {
  recordKind: SourceRecordKind;
  recordIndex?: number;
  externalId: string;
  sourceTime: Date;
  collectedAt: Date;
  payload: ProviderStreamRecordV2;
  projections: readonly CanonicalProjectionInput[];
  quarantine?: Omit<
    QuarantinedRecordInput,
    "payload" | "recordKind" | "recordIndex" | "externalId"
  >;
}

export interface QuarantinedRecordInput {
  recordKind: SourceRecordKind;
  recordIndex: number;
  externalId: string | null;
  reasonCode: string;
  fieldPath?: string;
  sanitizedSummary: string;
  payload: unknown;
}

export interface CommitPageInput {
  organizationId: string;
  providerId: string;
  configRevisionId: string;
  runId: string;
  pageNumber: number;
  requestedCursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  /** Small, protected page-level evidence. Archive imports must never store raw page bytes here. */
  payload: unknown;
  /** A caller-supplied SHA-256 of the exact page evidence bytes when available. */
  payloadHash?: string;
  /** Exact uncompressed NDJSON bytes represented by an archive page. */
  archiveUncompressedBytes?: number;
  /** Archive commits advance only the archive run cursor, never the live provider checkpoint. */
  checkpointMode: "provider" | "archive";
  records: readonly AcceptedSourceRecordInput[];
  quarantines?: readonly QuarantinedRecordInput[];
  committedAt: Date;
  /** Required by the production importer so stale or foreign workers cannot commit. */
  workerId?: string;
}

export interface CommitPageResult {
  kind: "committed" | "already_committed";
  pageId: string;
  counters: RunCounters;
  newCanonicalRevisions: number;
  duplicateSourceRecords: number;
}

export interface ProjectSourceRecordInput {
  organizationId: string;
  providerId: string;
  configurationRevisionId: string;
  quarantineId: string;
  attemptId: string;
  sourceRecordId: string;
  projections: readonly CanonicalProjectionInput[];
  acceptedAt: Date;
}

export interface ProjectDerivedSourceRecordInput {
  organizationId: string;
  providerId: string;
  configurationRevisionId: string;
  sourceRecordId: string;
  projections: readonly CanonicalProjectionInput[];
  acceptedAt: Date;
}

export interface MaterializeAndProjectSourceRecordInput {
  organizationId: string;
  providerId: string;
  configurationRevisionId: string;
  quarantineId: string;
  attemptId: string;
  runId: string;
  pageId: string;
  recordKind: SourceRecordKind;
  recordIndex: number;
  externalId: string;
  sourceTime: Date;
  collectedAt: Date;
  payload: ProviderStreamRecordV2;
  expiresAt: Date;
  projections: readonly CanonicalProjectionInput[];
  acceptedAt: Date;
}

export interface CurrentProjection {
  identity: CanonicalIdentity;
  entityId: string;
  revisionId: string;
  revisionNumber: number;
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
  actorKey: string | null;
  sourceUpdatedAt: Date;
  sourceCollectedAt: Date;
  acceptedAt: Date;
}

export interface CanonicalRevisionRecord extends CurrentProjection {
  sourceRecordId: string;
}

export interface RawEvidencePolicy {
  retentionDays: 90;
  actorPseudonymKey: Uint8Array | string;
}
import type { ProviderStreamRecordV2 } from "@packscout/contracts";
