import type {
  canonicalRecordKindEnum,
  recordKindEnum,
  RunCounters,
} from "./schema/index.ts";

export type SourceRecordKind = (typeof recordKindEnum.enumValues)[number];
export type CanonicalRecordKind = (typeof canonicalRecordKindEnum.enumValues)[number];

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
  payload: Record<string, unknown>;
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
  payload: unknown;
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
