import {
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseCompletedHeadV1,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralTransactionClient,
} from "./central-database.ts";
import {
  verifyProviderCompletedPublishPlanRelayProof,
  type VerifiedProviderCompletedPublishPlanRelayProof,
} from "./provider-completion-plan-contract.ts";
import {
  assertPromotionJobSha256,
  assertPromotionJobUuid,
  validDate,
} from "./promotion-job-persistence-types.ts";

const PROVIDER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TERMINAL_OPERATION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_MANIFEST_REFERENCES = 64;
const READ_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.ReadCommitted,
});

export interface ProviderCompletionPlanReadDeadline {
  readonly deadlineAt: number;
}

type PlanReadClient = Pick<CentralPrismaClient, "$queryRaw">;

function readTransactionOptions(deadline: ProviderCompletionPlanReadDeadline) {
  const available = Math.floor(deadline.deadlineAt - Date.now() - 50);
  const maxWait = Math.min(
    READ_TRANSACTION.maxWait,
    Math.max(1, Math.floor(available / 5)),
  );
  const timeout = Math.min(READ_TRANSACTION.timeout, available - maxWait);
  if (timeout < 1) {
    throw Object.assign(new Error("Provider plan read deadline reached."), {
      code: "PROMOTION_JOB_DEADLINE_EXCEEDED",
    });
  }
  return { ...READ_TRANSACTION, maxWait, timeout };
}

function boundedRead<T>(
  central: CentralPrismaClient,
  read: (client: PlanReadClient) => Promise<T>,
  deadline?: ProviderCompletionPlanReadDeadline,
): Promise<T> {
  if (deadline === undefined) return read(central);
  return central.$transaction(
    (transaction) => read(transaction),
    readTransactionOptions(deadline),
  );
}

interface PlanRow {
  eventId: string;
  providerId: string;
  providerKey: string;
  providerReleaseId: string;
  publicProviderReleaseId: string;
  providerReleaseFingerprint: string;
  catalogVersionId: string;
  catalogContentHash: string;
  providerReleaseContentHash: string;
  completedThroughChangeSequence: bigint;
  artifactAttemptId: string;
  terminalOperationKind: "finalize" | "confirmReuse";
  terminalOperationId: string;
  terminalReceiptSha256: string;
  evidenceDigest: string;
  activityEvidenceDigest: string;
  activityEventType: string;
  activityEventAt: Date;
  activityReceivedAt: Date;
  planSha256: string;
  planBytes: Uint8Array;
  completedHeadSha256: string;
  completedHeadBytes: Uint8Array;
  activeObservationSha256: string;
  activeObservationBytes: Uint8Array;
  verifiedAt: Date;
  createdAt: Date;
}

interface RetentionRow extends Omit<PlanRow,
  | "planBytes"
  | "completedHeadBytes"
  | "activeObservationBytes"
  | "activityEventType"
> {
  planByteCount: number;
  completedHeadByteCount: number;
  activeObservationByteCount: number;
}

const planProjection = CentralPrisma.sql`
  cache.event_id::text as "eventId",
  cache.provider_id::text as "providerId",
  provider.provider_key as "providerKey",
  cache.provider_release_id::text as "providerReleaseId",
  cache.public_provider_release_id::text as "publicProviderReleaseId",
  cache.provider_release_fingerprint as "providerReleaseFingerprint",
  cache.catalog_version_id::text as "catalogVersionId",
  cache.catalog_content_hash as "catalogContentHash",
  cache.provider_release_content_hash as "providerReleaseContentHash",
  cache.completed_through_change_sequence as "completedThroughChangeSequence",
  cache.artifact_attempt_id::text as "artifactAttemptId",
  cache.terminal_operation_kind as "terminalOperationKind",
  cache.terminal_operation_id as "terminalOperationId",
  cache.terminal_receipt_sha256 as "terminalReceiptSha256",
  cache.evidence_digest as "evidenceDigest",
  event.event_digest as "activityEvidenceDigest",
  event.event_type as "activityEventType",
  event.event_at as "activityEventAt",
  event.received_at as "activityReceivedAt",
  cache.plan_sha256 as "planSha256",
  cache.plan_bytes as "planBytes",
  cache.completed_head_sha256 as "completedHeadSha256",
  cache.completed_head_bytes as "completedHeadBytes",
  cache.active_observation_sha256 as "activeObservationSha256",
  cache.active_observation_bytes as "activeObservationBytes",
  cache.verified_at as "verifiedAt",
  cache.created_at as "createdAt"
`;

const retentionProjection = CentralPrisma.sql`
  cache.event_id::text as "eventId",
  cache.provider_id::text as "providerId",
  provider.provider_key as "providerKey",
  cache.provider_release_id::text as "providerReleaseId",
  cache.public_provider_release_id::text as "publicProviderReleaseId",
  cache.provider_release_fingerprint as "providerReleaseFingerprint",
  cache.catalog_version_id::text as "catalogVersionId",
  cache.catalog_content_hash as "catalogContentHash",
  cache.provider_release_content_hash as "providerReleaseContentHash",
  cache.completed_through_change_sequence as "completedThroughChangeSequence",
  cache.artifact_attempt_id::text as "artifactAttemptId",
  cache.terminal_operation_kind as "terminalOperationKind",
  cache.terminal_operation_id as "terminalOperationId",
  cache.terminal_receipt_sha256 as "terminalReceiptSha256",
  cache.evidence_digest as "evidenceDigest",
  event.event_digest as "activityEvidenceDigest",
  event.event_at as "activityEventAt",
  event.received_at as "activityReceivedAt",
  cache.plan_sha256 as "planSha256",
  cache.completed_head_sha256 as "completedHeadSha256",
  cache.active_observation_sha256 as "activeObservationSha256",
  octet_length(cache.plan_bytes)::integer as "planByteCount",
  octet_length(cache.completed_head_bytes)::integer as "completedHeadByteCount",
  octet_length(cache.active_observation_bytes)::integer as "activeObservationByteCount",
  cache.verified_at as "verifiedAt",
  cache.created_at as "createdAt"
`;

const joinedTables = CentralPrisma.sql`
  provider_completion_publish_plans cache
  join providers provider on provider.id = cache.provider_id
  join provider_activity_events event
    on event.provider_id = cache.provider_id and event.id = cache.event_id
`;

export interface ProviderManifestPlanReference {
  readonly providerKey: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
}

export interface ProviderCompletionPublishPlanRetentionMetadata {
  readonly eventId: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerReleaseId: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly catalogVersionId: string;
  readonly completedThroughChangeSequence: bigint;
  readonly artifactAttemptId: string;
  readonly terminalOperationKind: "finalize" | "confirmReuse";
  readonly terminalOperationId: string;
  readonly terminalReceiptSha256: string;
  readonly evidenceDigest: string;
  readonly planSha256: string;
  readonly completedHeadSha256: string;
  readonly activeObservationSha256: string;
  readonly planByteCount: number;
  readonly completedHeadByteCount: number;
  readonly activeObservationByteCount: number;
  readonly activityEventAt: Date;
  readonly activityReceivedAt: Date;
  readonly verifiedAt: Date;
  readonly createdAt: Date;
  /** Stable time from which a retention policy may measure age. */
  readonly retentionAnchorAt: Date;
}

export interface CachedProviderCompletionPublishPlan
  extends ProviderCompletionPublishPlanRetentionMetadata {
  readonly catalogContentHash: string;
  readonly providerReleaseContentHash: string;
  readonly plan: ProviderCatalogReleasePublishPlanV1;
  readonly completedHead: ProviderReleaseCompletedHeadV1;
  readonly activeObservation: GlobalCatalogProviderActiveObservationV1;
}

function repositoryFailure(): never {
  throw new Error("Provider completion publish-plan cache is inconsistent.");
}

function body(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    repositoryFailure();
  }
}

function parseBody(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    repositoryFailure();
  }
}

function validMetadata(row: Omit<RetentionRow,
  "planByteCount" | "completedHeadByteCount" | "activeObservationByteCount"
>): boolean {
  return row.providerKey.length <= 53 && PROVIDER_KEY_PATTERN.test(row.providerKey) &&
    row.completedThroughChangeSequence > 0n &&
    (row.terminalOperationKind === "finalize" ||
      row.terminalOperationKind === "confirmReuse") &&
    TERMINAL_OPERATION_ID_PATTERN.test(row.terminalOperationId) &&
    [
      row.providerReleaseFingerprint,
      row.catalogContentHash,
      row.providerReleaseContentHash,
      row.terminalReceiptSha256,
      row.evidenceDigest,
      row.activityEvidenceDigest,
      row.planSha256,
      row.completedHeadSha256,
      row.activeObservationSha256,
    ].every((value) => SHA256_PATTERN.test(value)) &&
    row.evidenceDigest === row.activityEvidenceDigest &&
    [row.activityEventAt, row.activityReceivedAt, row.verifiedAt, row.createdAt]
      .every(validDate);
}

function retentionMetadata(row: RetentionRow):
  ProviderCompletionPublishPlanRetentionMetadata {
  if (
    !validMetadata(row) ||
    !Number.isSafeInteger(row.planByteCount) || row.planByteCount < 2 ||
    !Number.isSafeInteger(row.completedHeadByteCount) ||
      row.completedHeadByteCount < 2 ||
    !Number.isSafeInteger(row.activeObservationByteCount) ||
      row.activeObservationByteCount < 2
  ) repositoryFailure();
  return {
    eventId: row.eventId.toLowerCase(),
    providerId: row.providerId.toLowerCase(),
    providerKey: row.providerKey,
    providerReleaseId: row.providerReleaseId.toLowerCase(),
    publicProviderReleaseId: row.publicProviderReleaseId.toLowerCase(),
    providerReleaseFingerprint: row.providerReleaseFingerprint,
    catalogVersionId: row.catalogVersionId.toLowerCase(),
    completedThroughChangeSequence: row.completedThroughChangeSequence,
    artifactAttemptId: row.artifactAttemptId.toLowerCase(),
    terminalOperationKind: row.terminalOperationKind,
    terminalOperationId: row.terminalOperationId,
    terminalReceiptSha256: row.terminalReceiptSha256,
    evidenceDigest: row.evidenceDigest,
    planSha256: row.planSha256,
    completedHeadSha256: row.completedHeadSha256,
    activeObservationSha256: row.activeObservationSha256,
    planByteCount: row.planByteCount,
    completedHeadByteCount: row.completedHeadByteCount,
    activeObservationByteCount: row.activeObservationByteCount,
    activityEventAt: row.activityEventAt,
    activityReceivedAt: row.activityReceivedAt,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    retentionAnchorAt: new Date(Math.max(
      row.activityReceivedAt.getTime(),
      row.verifiedAt.getTime(),
      row.createdAt.getTime(),
    )),
  };
}

async function cachedPlan(row: PlanRow): Promise<CachedProviderCompletionPublishPlan> {
  if (row.activityEventType !== "provider_release_completed" || !validMetadata(row)) {
    repositoryFailure();
  }
  const canonicalPlanBody = body(row.planBytes);
  const canonicalCompletedHeadBody = body(row.completedHeadBytes);
  const canonicalActiveObservationBody = body(row.activeObservationBytes);
  const verified = await verifyProviderCompletedPublishPlanRelayProof({
    providerId: row.providerId,
    providerKey: row.providerKey,
    providerReleaseId: row.providerReleaseId,
    publicProviderReleaseId: row.publicProviderReleaseId,
    providerReleaseFingerprint: row.providerReleaseFingerprint,
    catalogVersionId: row.catalogVersionId,
    catalogContentHash: row.catalogContentHash,
    providerReleaseContentHash: row.providerReleaseContentHash,
    completedThroughChangeSequence: row.completedThroughChangeSequence,
    artifactAttemptId: row.artifactAttemptId,
    terminalOperationKind: row.terminalOperationKind,
    terminalOperationId: row.terminalOperationId,
    terminalReceiptSha256: row.terminalReceiptSha256,
    plan: parseBody(canonicalPlanBody) as ProviderCatalogReleasePublishPlanV1,
    completedHead: parseBody(canonicalCompletedHeadBody) as ProviderReleaseCompletedHeadV1,
    activeObservation: parseBody(canonicalActiveObservationBody) as
      GlobalCatalogProviderActiveObservationV1,
  });
  if (
    verified.canonicalPlanBody !== canonicalPlanBody ||
    verified.planSha256 !== row.planSha256 ||
    verified.canonicalCompletedHeadBody !== canonicalCompletedHeadBody ||
    verified.completedHeadSha256 !== row.completedHeadSha256 ||
    verified.canonicalActiveObservationBody !== canonicalActiveObservationBody ||
    verified.activeObservationSha256 !== row.activeObservationSha256
  ) repositoryFailure();
  const metadata = retentionMetadata({
    ...row,
    planByteCount: row.planBytes.byteLength,
    completedHeadByteCount: row.completedHeadBytes.byteLength,
    activeObservationByteCount: row.activeObservationBytes.byteLength,
  });
  return {
    ...metadata,
    catalogContentHash: row.catalogContentHash,
    providerReleaseContentHash: row.providerReleaseContentHash,
    plan: verified.plan,
    completedHead: verified.completedHead,
    activeObservation: verified.activeObservation,
  };
}

function rowMatches(
  row: PlanRow,
  input: Readonly<{
    eventId: string;
    evidenceDigest: string;
    verifiedAt: Date;
    proof: VerifiedProviderCompletedPublishPlanRelayProof;
  }>,
): boolean {
  const proof = input.proof;
  return row.eventId === input.eventId &&
    row.providerId === proof.providerId &&
    row.providerKey === proof.providerKey &&
    row.providerReleaseId === proof.providerReleaseId &&
    row.publicProviderReleaseId === proof.publicProviderReleaseId &&
    row.providerReleaseFingerprint === proof.providerReleaseFingerprint &&
    row.catalogVersionId === proof.catalogVersionId &&
    row.catalogContentHash === proof.catalogContentHash &&
    row.providerReleaseContentHash === proof.providerReleaseContentHash &&
    row.completedThroughChangeSequence ===
      proof.completedThroughChangeSequence &&
    row.artifactAttemptId === proof.artifactAttemptId &&
    row.terminalOperationKind === proof.terminalOperationKind &&
    row.terminalOperationId === proof.terminalOperationId &&
    row.terminalReceiptSha256 === proof.terminalReceiptSha256 &&
    row.evidenceDigest === input.evidenceDigest &&
    row.activityEvidenceDigest === input.evidenceDigest &&
    row.planSha256 === proof.planSha256 &&
    body(row.planBytes) === proof.canonicalPlanBody &&
    row.completedHeadSha256 === proof.completedHeadSha256 &&
    body(row.completedHeadBytes) === proof.canonicalCompletedHeadBody &&
    row.activeObservationSha256 === proof.activeObservationSha256 &&
    body(row.activeObservationBytes) === proof.canonicalActiveObservationBody;
}

/** Central immutable plan cache; it never opens a provider connection. */
export class PrismaProviderCompletionPublishPlanRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async persistAcceptedCompletion(input: Readonly<{
    eventId: string;
    evidenceDigest: string;
    verifiedAt: Date;
    proof: VerifiedProviderCompletedPublishPlanRelayProof;
  }>, transaction: CentralTransactionClient): Promise<"inserted" | "deduplicated"> {
    assertPromotionJobUuid(input.eventId);
    assertPromotionJobSha256(input.evidenceDigest);
    if (!validDate(input.verifiedAt)) repositoryFailure();
    const proof = input.proof;
    const [scope] = await transaction.$queryRaw<Array<{
      providerKey: string;
      catalogLifecycle: string;
      catalogContentHash: string;
    }>>(CentralPrisma.sql`
      select provider.provider_key as "providerKey",
             catalog.lifecycle::text as "catalogLifecycle",
             catalog.content_hash as "catalogContentHash"
      from providers provider
      join catalog_versions catalog on catalog.id = ${proof.catalogVersionId}::uuid
      where provider.id = ${proof.providerId}::uuid
    `);
    if (
      !scope || scope.providerKey !== proof.providerKey ||
      scope.catalogLifecycle !== "complete" ||
      scope.catalogContentHash !== proof.catalogContentHash
    ) repositoryFailure();

    await transaction.$queryRaw<Array<{ locked: boolean }>>(CentralPrisma.sql`
      select true as "locked" from (
        select pg_advisory_xact_lock(hashtextextended(
          ${`provider-completion-plan:${proof.providerId}`},
          0
        ))
      ) acquired
    `);
    const priorIdentity = await transaction.$queryRaw<Array<{
      providerReleaseId: string;
      publicProviderReleaseId: string;
      providerReleaseFingerprint: string;
      catalogVersionId: string;
      catalogContentHash: string;
      providerReleaseContentHash: string;
      planSha256: string;
      planBytes: Uint8Array;
    }>>(CentralPrisma.sql`
      select provider_release_id::text as "providerReleaseId",
             public_provider_release_id::text as "publicProviderReleaseId",
             provider_release_fingerprint as "providerReleaseFingerprint",
             catalog_version_id::text as "catalogVersionId",
             catalog_content_hash as "catalogContentHash",
             provider_release_content_hash as "providerReleaseContentHash",
             plan_sha256 as "planSha256", plan_bytes as "planBytes"
      from provider_completion_publish_plans
      where provider_id = ${proof.providerId}::uuid and (
        provider_release_id = ${proof.providerReleaseId}::uuid
        or (
          public_provider_release_id = ${proof.publicProviderReleaseId}::uuid
          and provider_release_fingerprint =
            ${proof.providerReleaseFingerprint}
        )
      )
      for share
    `);
    if (priorIdentity.some((row) =>
      row.planSha256 !== proof.planSha256 ||
      body(row.planBytes) !== proof.canonicalPlanBody ||
      (row.providerReleaseId === proof.providerReleaseId && (
        row.publicProviderReleaseId !== proof.publicProviderReleaseId ||
        row.providerReleaseFingerprint !== proof.providerReleaseFingerprint ||
        row.catalogVersionId !== proof.catalogVersionId ||
        row.catalogContentHash !== proof.catalogContentHash ||
        row.providerReleaseContentHash !== proof.providerReleaseContentHash
      ))
    )) repositoryFailure();

    const inserted = await transaction.$executeRaw(CentralPrisma.sql`
      insert into provider_completion_publish_plans (
        event_id, provider_id, provider_release_id,
        public_provider_release_id, provider_release_fingerprint,
        catalog_version_id, catalog_content_hash,
        provider_release_content_hash, completed_through_change_sequence,
        artifact_attempt_id, terminal_operation_kind, terminal_operation_id,
        terminal_receipt_sha256, evidence_digest, plan_sha256, plan_bytes,
        completed_head_sha256, completed_head_bytes,
        active_observation_sha256, active_observation_bytes,
        verified_at, created_at
      ) values (
        ${input.eventId}::uuid, ${proof.providerId}::uuid,
        ${proof.providerReleaseId}::uuid,
        ${proof.publicProviderReleaseId}::uuid,
        ${proof.providerReleaseFingerprint}, ${proof.catalogVersionId}::uuid,
        ${proof.catalogContentHash}, ${proof.providerReleaseContentHash},
        ${proof.completedThroughChangeSequence}, ${proof.artifactAttemptId}::uuid,
        ${proof.terminalOperationKind}, ${proof.terminalOperationId},
        ${proof.terminalReceiptSha256}, ${input.evidenceDigest},
        ${proof.planSha256}, ${Buffer.from(proof.canonicalPlanBody, "utf8")},
        ${proof.completedHeadSha256},
        ${Buffer.from(proof.canonicalCompletedHeadBody, "utf8")},
        ${proof.activeObservationSha256},
        ${Buffer.from(proof.canonicalActiveObservationBody, "utf8")},
        ${input.verifiedAt}, ${input.verifiedAt}
      ) on conflict do nothing
    `);
    const rows = await transaction.$queryRaw<PlanRow[]>(CentralPrisma.sql`
      select ${planProjection} from ${joinedTables}
      where cache.event_id = ${input.eventId}::uuid
         or (cache.provider_id = ${proof.providerId}::uuid
           and cache.evidence_digest = ${input.evidenceDigest})
         or (cache.provider_id = ${proof.providerId}::uuid
           and cache.artifact_attempt_id = ${proof.artifactAttemptId}::uuid)
         or (cache.provider_id = ${proof.providerId}::uuid
           and cache.provider_release_id = ${proof.providerReleaseId}::uuid
           and cache.completed_through_change_sequence =
             ${proof.completedThroughChangeSequence})
    `);
    if (rows.length < 1 || rows.some((row) => !rowMatches(row, input))) {
      repositoryFailure();
    }
    return inserted === 1 ? "inserted" : "deduplicated";
  }

  async loadByEvidence(input: Readonly<{
    providerId: string;
    evidenceDigest: string;
  }>, deadline?: ProviderCompletionPlanReadDeadline): Promise<
    CachedProviderCompletionPublishPlan | null
  > {
    assertPromotionJobUuid(input.providerId);
    assertPromotionJobSha256(input.evidenceDigest);
    const [row] = await boundedRead(
      this.central,
      (client) => client.$queryRaw<PlanRow[]>(CentralPrisma.sql`
        select ${planProjection} from ${joinedTables}
        where cache.provider_id = ${input.providerId}::uuid
          and cache.evidence_digest = ${input.evidenceDigest}
      `),
      deadline,
    );
    return row ? cachedPlan(row) : null;
  }

  async loadExact(input: Readonly<{
    providerId: string;
    providerReleaseId: string;
    publicProviderReleaseId: string;
    providerReleaseFingerprint: string;
    artifactAttemptId: string;
    evidenceDigest: string;
  }>): Promise<CachedProviderCompletionPublishPlan | null> {
    assertPromotionJobUuid(input.providerId);
    assertPromotionJobUuid(input.providerReleaseId);
    assertPromotionJobUuid(input.publicProviderReleaseId);
    assertPromotionJobUuid(input.artifactAttemptId);
    assertPromotionJobSha256(input.providerReleaseFingerprint);
    assertPromotionJobSha256(input.evidenceDigest);
    const [row] = await this.central.$queryRaw<PlanRow[]>(CentralPrisma.sql`
      select ${planProjection} from ${joinedTables}
      where cache.provider_id = ${input.providerId}::uuid
        and cache.provider_release_id = ${input.providerReleaseId}::uuid
        and cache.public_provider_release_id =
          ${input.publicProviderReleaseId}::uuid
        and cache.provider_release_fingerprint =
          ${input.providerReleaseFingerprint}
        and cache.artifact_attempt_id = ${input.artifactAttemptId}::uuid
        and cache.evidence_digest = ${input.evidenceDigest}
    `);
    return row ? cachedPlan(row) : null;
  }

  /**
   * Resolves the newest verified completion for an explicit operation target.
   * The caller supplies only identities carried by ManifestGateClaim, so every
   * matching completion must describe the same immutable release plan. Missing
   * and ambiguous targets both fail closed.
   */
  async loadExplicitTarget(input: Readonly<{
    providerId: string;
    providerReleaseId: string;
    catalogVersionId: string;
  }>, deadline?: ProviderCompletionPlanReadDeadline): Promise<
    CachedProviderCompletionPublishPlan
  > {
    assertPromotionJobUuid(input.providerId);
    assertPromotionJobUuid(input.providerReleaseId);
    assertPromotionJobUuid(input.catalogVersionId);
    const rows = await boundedRead(
      this.central,
      (client) => client.$queryRaw<PlanRow[]>(CentralPrisma.sql`
        select ${planProjection} from ${joinedTables}
        where cache.provider_id = ${input.providerId}::uuid
          and cache.provider_release_id = ${input.providerReleaseId}::uuid
          and cache.catalog_version_id = ${input.catalogVersionId}::uuid
        order by cache.completed_through_change_sequence desc,
                 event.received_at desc,
                 cache.event_id desc
      `),
      deadline,
    );
    const [newest] = rows;
    if (!newest) repositoryFailure();
    if (rows.some((row) =>
      row.publicProviderReleaseId !== newest.publicProviderReleaseId ||
      row.providerReleaseFingerprint !== newest.providerReleaseFingerprint ||
      row.catalogContentHash !== newest.catalogContentHash ||
      row.providerReleaseContentHash !== newest.providerReleaseContentHash ||
      row.planSha256 !== newest.planSha256 ||
      body(row.planBytes) !== body(newest.planBytes)
    )) repositoryFailure();
    return cachedPlan(newest);
  }

  /** Loads one newest exact cached plan for every current manifest reference. */
  async loadForManifestReferences(
    references: readonly ProviderManifestPlanReference[],
    deadline?: ProviderCompletionPlanReadDeadline,
  ): Promise<readonly CachedProviderCompletionPublishPlan[] | null> {
    if (
      references.length < 1 || references.length > MAX_MANIFEST_REFERENCES ||
      new Set(references.map(({ providerKey }) => providerKey)).size !==
        references.length
    ) repositoryFailure();
    for (const reference of references) {
      if (
        reference.providerKey.length > 53 ||
        !PROVIDER_KEY_PATTERN.test(reference.providerKey)
      ) repositoryFailure();
      assertPromotionJobUuid(reference.publicProviderReleaseId);
      assertPromotionJobSha256(reference.providerReleaseFingerprint);
    }
    const predicates = references.map((reference) => CentralPrisma.sql`(
      provider.provider_key = ${reference.providerKey}
      and cache.public_provider_release_id =
        ${reference.publicProviderReleaseId}::uuid
      and cache.provider_release_fingerprint =
        ${reference.providerReleaseFingerprint}
    )`);
    const rows = await boundedRead(
      this.central,
      (client) => client.$queryRaw<PlanRow[]>(CentralPrisma.sql`
        select distinct on (
          provider.provider_key, cache.public_provider_release_id,
          cache.provider_release_fingerprint
        ) ${planProjection}
        from ${joinedTables}
        where ${CentralPrisma.join(predicates, " OR ")}
        order by provider.provider_key, cache.public_provider_release_id,
                 cache.provider_release_fingerprint,
                 cache.completed_through_change_sequence desc,
                 cache.evidence_digest desc
      `),
      deadline,
    );
    const byKey = new Map(rows.map((row) => [row.providerKey, row]));
    if (references.some((reference) => !byKey.has(reference.providerKey))) {
      return null;
    }
    const result: CachedProviderCompletionPublishPlan[] = [];
    for (const reference of [...references].sort((left, right) =>
      left.providerKey < right.providerKey ? -1 : 1)) {
      const cached = await cachedPlan(byKey.get(reference.providerKey)!);
      if (
        cached.publicProviderReleaseId !==
          reference.publicProviderReleaseId.toLowerCase() ||
        cached.providerReleaseFingerprint !==
          reference.providerReleaseFingerprint
      ) repositoryFailure();
      result.push(cached);
    }
    return result;
  }

  async listRetentionMetadata(input: Readonly<{
    providerId?: string;
    verifiedBefore?: Date;
    limit: number;
  }>): Promise<readonly ProviderCompletionPublishPlanRetentionMetadata[]> {
    if (input.providerId !== undefined) {
      assertPromotionJobUuid(input.providerId);
    }
    if (input.verifiedBefore !== undefined && !validDate(input.verifiedBefore)) {
      repositoryFailure();
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      repositoryFailure();
    }
    const rows = await this.central.$queryRaw<RetentionRow[]>(CentralPrisma.sql`
      select ${retentionProjection} from ${joinedTables}
      where (${input.providerId ?? null}::uuid is null
          or cache.provider_id = ${input.providerId ?? null}::uuid)
        and (${input.verifiedBefore ?? null}::timestamptz is null
          or cache.verified_at < ${input.verifiedBefore ?? null})
      order by cache.verified_at, cache.event_id
      limit ${input.limit}
    `);
    return rows.map(retentionMetadata);
  }
}
