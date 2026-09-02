import {
  activeCatalogManifestStateV1Schema,
  CATALOG_RETENTION_COMPLETE_MILLISECONDS,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestBlockRequestSchema,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRollbackRequestSchema,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionPostgresProofSnapshotSchema,
  globalCatalogManifestIdentityV1Schema,
  providerCatalogPlatformKeyV1Schema,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseImmutableProofV1Schema,
  providerReleaseStartRequestSchema,
  providerReleaseExpectedCompletedHeadV1Schema,
  providerReleaseCompletedHeadResultV1Schema,
  type CatalogRetentionExternalManifestProtection,
  type CatalogRetentionExternalProviderProtection,
  type CatalogRetentionPostgresProofSnapshot,
  type CatalogRetentionProviderReleaseIdentity,
  type CatalogManifestMutationRequest,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import {
  CatalogPromotionRetentionPersistenceError,
  type CatalogPromotionRetentionScopeBinding,
} from "./catalog-promotion-retention-types.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";
import { parseHeatManifestSourceProof } from
  "./active-catalog-heat-manifest.ts";
import {
  parseProviderPromotionReceiptEvidence,
  type ProviderPromotionOperationRow,
} from "./provider-promotion-repository-validation.ts";
import {
  parseManifestPromotionReceiptEvidence,
  type ManifestPromotionOperationRow,
} from "./manifest-promotion-repository-validation.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function proofIncomplete(): never {
  throw new CatalogPromotionRetentionPersistenceError(
    "CATALOG_PROMOTION_RETENTION_PROOF_INCOMPLETE",
  );
}

function parseCanonical<T>(body: string, schema: { parse(value: unknown): T }): T {
  try {
    const parsed = schema.parse(JSON.parse(body));
    if (canonicalJson(parsed) !== body) proofIncomplete();
    return parsed;
  } catch (error) {
    if (error instanceof CatalogPromotionRetentionPersistenceError) throw error;
    return proofIncomplete();
  }
}

export function parseCatalogPromotionRetentionPlatformKeys(
  body: string,
  sha256: string,
): readonly string[] {
  if (promotionV2Sha256(body) !== sha256) return proofIncomplete();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return proofIncomplete();
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES ||
    value.some((key) => !providerCatalogPlatformKeyV1Schema.safeParse(key).success) ||
    value.some((key, index) => index > 0 && String(value[index - 1]) >= String(key)) ||
    canonicalJson(value) !== body
  ) return proofIncomplete();
  return value as string[];
}

interface ManifestLaneProofRow {
  bootstrapState: string;
  bootstrapProviderSetBody: string | null;
  bootstrapProviderSetSha256: string | null;
  activeGeneration: bigint;
  activeStateBody: string | null;
  activeStateSha256: string | null;
  activeTerminalReceiptSha256: string | null;
  activePublicReleaseId: string | null;
  activeManifestFingerprint: string | null;
  activeProviderReferenceSetHash: string | null;
  activeConfigurationEpochSequence: bigint | null;
}

interface ProviderLaneProofRow {
  platformKey: string;
  completedCheckpoint: bigint;
  completedHeadBody: string | null;
  completedHeadSha256: string | null;
  completedTerminalOperationId: string | null;
  completedTerminalReceiptSha256: string | null;
  completedPublicProviderReleaseId: string | null;
  completedProviderReleaseFingerprint: string | null;
  completedTerminalOperationKind: string | null;
  completedAttemptId: string | null;
}

interface CurrentBootstrapProviderProofRow {
  ordinal: number;
  platformKey: string;
  publicProviderReleaseId: string | null;
  providerReleaseFingerprint: string | null;
  providerTerminalOperationId: string | null;
  providerTerminalReceiptBody: string | null;
  providerTerminalReceiptSha256: string | null;
  providerTerminalResponseBody: string | null;
  providerTerminalResponseSha256: string | null;
  publishArtifactAttemptId: string | null;
  localCompletedAttemptId: string | null;
  localCompletedPublicProviderReleaseId: string | null;
  localCompletedProviderReleaseFingerprint: string | null;
  localCompletedTerminalReceiptSha256: string | null;
}

interface ProviderArtifactProofRow {
  immutableProofBody: string;
  immutableProofSha256: string;
  publishArtifactAttemptId: string;
}

interface OperationProofRow extends ProviderPromotionOperationRow,
  ManifestPromotionOperationRow {
  attemptId: string;
  platformKey: string | null;
  publicReleaseId: string | null;
  fingerprint: string | null;
  preparedSummaryBody: string | null;
  attemptState: string;
  terminalAt: Date | null;
  operationState: "pending" | "sent" | "acknowledged";
}

function operationProof(row: OperationProofRow) {
  if (
    promotionV2Sha256(row.canonicalRequestBody) !== row.requestSha256 ||
    (row.operationState === "acknowledged") !== (row.receiptSha256 !== null) ||
    (row.operationState === "acknowledged") !==
      (row.canonicalReceiptBody !== null) ||
    (row.canonicalReceiptBody !== null &&
      promotionV2Sha256(row.canonicalReceiptBody) !== row.receiptSha256)
  ) return proofIncomplete();
  return {
    operationKind: row.operationKind,
    operationId: row.operationId,
    operationState: row.operationState,
    canonicalRequestBody: row.operationState === "acknowledged"
      ? null
      : row.canonicalRequestBody,
    requestDigest: row.requestSha256,
    terminalReceiptSha256: row.receiptSha256,
  };
}

function validateProviderOperation(row: OperationProofRow) {
  providerIdentity(row);
  if (row.operationState === "acknowledged") {
    if (row.canonicalReceiptBody === null) return proofIncomplete();
    try {
      const parsed = parseProviderPromotionReceiptEvidence(row, {
        canonicalReceiptBody: row.canonicalReceiptBody,
        exactResponseBody: row.exactResponseBody,
      });
      if (parsed.receiptSha256 !== row.receiptSha256 ||
        parsed.responseSha256 !== row.responseSha256) return proofIncomplete();
    } catch {
      return proofIncomplete();
    }
  }
  return operationProof(row);
}

function manifestRequest(row: OperationProofRow): CatalogManifestMutationRequest {
  switch (row.operationKind) {
    case "activateManifest":
      return parseCanonical(
        row.canonicalRequestBody, catalogManifestActivateRequestSchema,
      );
    case "refreshActiveState":
      return parseCanonical(
        row.canonicalRequestBody, catalogManifestRefreshActiveStateRequestSchema,
      );
    case "rollback":
      return parseCanonical(
        row.canonicalRequestBody, catalogManifestRollbackRequestSchema,
      );
    case "block":
      return parseCanonical(
        row.canonicalRequestBody, catalogManifestBlockRequestSchema,
      );
    default:
      return proofIncomplete();
  }
}

function validateManifestOperation(row: OperationProofRow) {
  manifestRequest(row);
  if (row.operationState === "acknowledged") {
    if (row.canonicalReceiptBody === null) return proofIncomplete();
    try {
      const parsed = parseManifestPromotionReceiptEvidence(row, {
        canonicalReceiptBody: row.canonicalReceiptBody,
        exactResponseBody: row.exactResponseBody,
      });
      if (parsed.receiptSha256 !== row.receiptSha256 ||
        parsed.responseSha256 !== row.responseSha256) return proofIncomplete();
    } catch {
      return proofIncomplete();
    }
  }
  return operationProof(row);
}

function providerRequest(row: OperationProofRow) {
  const schema = row.operationKind === "start"
    ? providerReleaseStartRequestSchema
    : row.operationKind === "applyBatch"
    ? providerReleaseApplyBatchRequestSchema
    : row.operationKind === "finalize"
    ? providerReleaseFinalizeRequestSchema
    : row.operationKind === "confirmReuse"
    ? providerReleaseConfirmReuseRequestSchema
    : row.operationKind === "block"
    ? providerReleaseBlockRequestSchema
    : null;
  if (schema === null) return proofIncomplete();
  return parseCanonical(row.canonicalRequestBody, schema);
}

function providerIdentity(row: OperationProofRow):
  CatalogRetentionProviderReleaseIdentity {
  const request = providerRequest(row);
  if (
    row.platformKey === null || row.publicReleaseId === null ||
    row.fingerprint === null || request.release.platformKey !== row.platformKey ||
    request.release.publicProviderReleaseId !== row.publicReleaseId ||
    request.release.providerReleaseFingerprint !== row.fingerprint
  ) return proofIncomplete();
  return {
    platformKey: row.platformKey,
    publicProviderReleaseId: row.publicReleaseId,
    providerReleaseFingerprint: row.fingerprint,
  };
}

function providerRequestContext(row: OperationProofRow): string {
  const request = providerRequest(row);
  return canonicalJson({
    expectedCompletedHead: request.expectedCompletedHead,
    observation: request.observation,
    providerCheckpoint: request.providerCheckpoint,
    release: request.release,
    sourceWatermark: request.sourceWatermark,
  });
}

function validateProviderAttemptRows(rows: readonly OperationProofRow[]) {
  const first = rows[0];
  if (!first?.operationId) return proofIncomplete();
  const release = providerIdentity(first);
  const context = providerRequestContext(first);
  let sawPending = false;
  let sentCount = 0;
  for (const [index, row] of rows.entries()) {
    const candidate = providerIdentity(row);
    if (row.operationIndex !== index || canonicalJson(candidate) !==
      canonicalJson(release) || providerRequestContext(row) !== context ||
      (sawPending && row.operationState === "acknowledged")) {
      return proofIncomplete();
    }
    if (row.operationState === "sent") sentCount += 1;
    if (row.operationState !== "acknowledged") sawPending = true;
    validateProviderOperation(row);
  }
  if (sentCount > 1) return proofIncomplete();
  const kinds = rows.map(({ operationKind }) => operationKind);
  if (kinds.length === 1) {
    if (!["confirmReuse", "block"].includes(kinds[0]!)) {
      return proofIncomplete();
    }
  } else {
    const firstRequest = providerRequest(first);
    if (kinds[0] !== "start" || kinds.at(-1) !== "finalize" ||
      rows.length !== firstRequest.release.batchCount + 2) {
      return proofIncomplete();
    }
    for (let index = 1; index < rows.length - 1; index += 1) {
      const row = rows[index]!;
      if (row.operationKind !== "applyBatch") return proofIncomplete();
      const request = parseCanonical(
        row.canonicalRequestBody, providerReleaseApplyBatchRequestSchema,
      );
      if (
        request.batch.batchIndex !== index - 1) return proofIncomplete();
    }
  }
  const representative = rows.find(({ operationState }) =>
    operationState === "sent") ?? rows.at(-1)!;
  const reason = representative.operationState === "acknowledged" &&
      representative.operationKind === "block"
    ? "block_recovery" as const
    : representative.operationState === "acknowledged" &&
        (representative.operationKind === "finalize" ||
          representative.operationKind === "confirmReuse")
    ? "rollback_recovery" as const
    : "in_flight_attempt" as const;
  return {
    release,
    reason,
    operationProof: operationProof(representative),
  } as CatalogRetentionExternalProviderProtection;
}

function manifestIdentity(row: OperationProofRow) {
  const value = manifestRequest(row);
  if (row.operationKind === "activateManifest" && "manifest" in value) {
    return globalCatalogManifestIdentityV1Schema.parse({
      publicReleaseId: value.manifest.publicReleaseId,
      manifestFingerprint: value.manifest.manifestFingerprint,
      sharedConfigurationEpoch: value.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: value.manifest.providerReferenceSetHash,
    });
  }
  if (row.operationKind === "rollback" && "rollbackKind" in value &&
    value.rollbackKind === "manifest" && "targetManifest" in value) {
    return value.targetManifest;
  }
  if (row.operationKind === "block" && row.preparedSummaryBody !== null) {
    try {
      const summary = JSON.parse(row.preparedSummaryBody) as {
        manifestIdentity?: unknown;
      };
      return globalCatalogManifestIdentityV1Schema.parse(summary.manifestIdentity);
    } catch {
      return proofIncomplete();
    }
  }
  return null;
}

async function loadActiveState(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  lane: ManifestLaneProofRow,
) {
  if (lane.activeStateBody === null || lane.activeStateSha256 === null ||
    promotionV2Sha256(lane.activeStateBody) !== lane.activeStateSha256) {
    return proofIncomplete();
  }
  const state = parseCanonical(
    lane.activeStateBody, activeCatalogManifestStateV1Schema,
  );
  if (BigInt(state.generation) !== lane.activeGeneration ||
    state.terminalReceiptSha256 !== lane.activeTerminalReceiptSha256) {
    return proofIncomplete();
  }
  const activeManifest = state.activeManifest;
  if (
    (activeManifest === null) !== (lane.activePublicReleaseId === null) ||
    (activeManifest === null) !== (lane.activeManifestFingerprint === null) ||
    (activeManifest === null) !==
      (lane.activeProviderReferenceSetHash === null) ||
    (activeManifest === null) !==
      (lane.activeConfigurationEpochSequence === null) ||
    (activeManifest !== null && (
      activeManifest.publicReleaseId !== lane.activePublicReleaseId ||
      activeManifest.manifestFingerprint !== lane.activeManifestFingerprint ||
      activeManifest.providerReferenceSetHash !==
        lane.activeProviderReferenceSetHash ||
      BigInt(activeManifest.sharedConfigurationEpoch.publicChangeSequence) !==
        lane.activeConfigurationEpochSequence
    ))
  ) return proofIncomplete();
  if (state.generation === 0) return { state, terminalOperationId: null };
  const operations = await loadManifestOperationRows(
    transaction,
    binding,
    Prisma.sql`operation.state = 'acknowledged'
      and operation.receipt_sha256 = ${state.terminalReceiptSha256}`,
  );
  if (operations.length !== 1) return proofIncomplete();
  const operation = operations[0]!;
  validateManifestOperation(operation);
  try {
    const parsed = parseManifestPromotionReceiptEvidence(operation, {
      canonicalReceiptBody: operation.canonicalReceiptBody!,
      exactResponseBody: operation.exactResponseBody,
    });
    const { terminalReceiptSha256: _terminalReceiptSha256, ...stateCore } = state;
    void _terminalReceiptSha256;
    if (!("activeState" in parsed.receipt.details) ||
      canonicalJson(parsed.receipt.details.activeState) !==
        canonicalJson(stateCore)) {
      return proofIncomplete();
    }
  } catch {
    return proofIncomplete();
  }
  return { state, terminalOperationId: operation.operationId };
}

async function loadProviderOperationRows(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  predicate: Prisma.Sql,
) {
  return transaction.$queryRaw<OperationProofRow[]>(Prisma.sql`
    select attempt.id::text as "attemptId",
           attempt.platform_key as "platformKey",
           attempt.public_provider_release_id::text as "publicReleaseId",
           attempt.provider_release_fingerprint as fingerprint,
           attempt.prepared_summary_body as "preparedSummaryBody",
           attempt.state as "attemptState", attempt.terminal_at as "terminalAt",
           operation.operation_index as "operationIndex",
           operation.operation_id as "operationId",
           operation.operation_kind as "operationKind",
           operation.request_path as "requestPath",
           operation.canonical_request_body as "canonicalRequestBody",
           operation.request_sha256 as "requestSha256",
           operation.state, operation.state as "operationState",
           operation.send_count as "sendCount",
           operation.last_sent_at as "lastSentAt",
           operation.acknowledged_at as "acknowledgedAt",
           operation.canonical_receipt_body as "canonicalReceiptBody",
           operation.receipt_sha256 as "receiptSha256",
           operation.exact_response_body as "exactResponseBody",
           operation.response_sha256 as "responseSha256"
    from public.provider_promotion_operations as operation
    join public.provider_promotion_attempts as attempt
      on attempt.id = operation.attempt_id
     and attempt.organization_id = operation.organization_id
     and attempt.deployment_key = operation.deployment_key
     and attempt.platform_key = operation.platform_key
    where operation.organization_id = ${uuid(binding.organizationId)}
      and operation.deployment_key = ${binding.deploymentKey}
      and ${predicate}
    order by operation.operation_id collate "C"
  `);
}

async function loadExactBootstrapProviderProtection(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  input: Readonly<{
    release: CatalogRetentionProviderReleaseIdentity;
    operationPredicate: Prisma.Sql;
    terminalReceiptSha256: string;
    storedActiveEvidence: Readonly<{
      receiptBody: string;
      responseBody: string | null;
      responseSha256: string | null;
      publishArtifactAttemptId: string;
    }> | null;
  }>,
): Promise<CatalogRetentionExternalProviderProtection> {
  const artifacts = await transaction.$queryRaw<ProviderArtifactProofRow[]>(
      Prisma.sql`
        select immutable_proof_body as "immutableProofBody",
               immutable_proof_sha256 as "immutableProofSha256",
               publish_attempt_id::text as "publishArtifactAttemptId"
        from public.provider_release_artifacts
        where organization_id = ${uuid(binding.organizationId)}
          and deployment_key = ${binding.deploymentKey}
          and platform_key = ${input.release.platformKey}
          and public_provider_release_id = ${uuid(
            input.release.publicProviderReleaseId,
          )}
          and provider_release_fingerprint =
            ${input.release.providerReleaseFingerprint}
      `,
    );
  const artifact = artifacts[0];
  if (
    artifacts.length !== 1 || artifact === undefined ||
    (input.storedActiveEvidence !== null &&
      artifact.publishArtifactAttemptId !==
        input.storedActiveEvidence.publishArtifactAttemptId) ||
    promotionV2Sha256(artifact.immutableProofBody) !==
      artifact.immutableProofSha256
  ) return proofIncomplete();
  const immutableProof = parseCanonical(
    artifact.immutableProofBody,
    providerReleaseImmutableProofV1Schema,
  );
  if (
    immutableProof.platformKey !== input.release.platformKey ||
    immutableProof.publicProviderReleaseId !==
      input.release.publicProviderReleaseId ||
    immutableProof.providerReleaseFingerprint !==
      input.release.providerReleaseFingerprint
  ) return proofIncomplete();

  const operations = await loadProviderOperationRows(
    transaction,
    binding,
    input.operationPredicate,
  );
  const operation = operations[0];
  if (
    operations.length !== 1 || operation === undefined ||
    (operation.operationKind !== "finalize" &&
      operation.operationKind !== "confirmReuse") ||
    operation.receiptSha256 !== input.terminalReceiptSha256 ||
    canonicalJson(providerIdentity(operation)) !== canonicalJson(input.release) ||
    (input.storedActiveEvidence !== null && (
      operation.canonicalReceiptBody !==
        input.storedActiveEvidence.receiptBody ||
      operation.exactResponseBody !==
        input.storedActiveEvidence.responseBody ||
      operation.responseSha256 !==
        input.storedActiveEvidence.responseSha256
    ))
  ) return proofIncomplete();
  return {
    release: input.release,
    // The current bootstrap revision is the durable recovery root for the
    // exact acknowledged provider terminal operation that established it.
    reason: "rollback_recovery",
    operationProof: validateProviderOperation(operation) as
      CatalogRetentionExternalProviderProtection["operationProof"],
  };
}

async function loadCurrentBootstrapProviderProtections(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  platformKeys: readonly string[],
): Promise<readonly CatalogRetentionExternalProviderProtection[]> {
  const rows = await transaction.$queryRaw<CurrentBootstrapProviderProofRow[]>(
    Prisma.sql`
      select proof.ordinal, proof.platform_key as "platformKey",
             proof.public_provider_release_id::text
               as "publicProviderReleaseId",
             proof.provider_release_fingerprint
               as "providerReleaseFingerprint",
             proof.provider_terminal_operation_id
               as "providerTerminalOperationId",
             proof.provider_terminal_receipt_body
               as "providerTerminalReceiptBody",
             proof.provider_terminal_receipt_sha256
               as "providerTerminalReceiptSha256",
             proof.provider_terminal_response_body
               as "providerTerminalResponseBody",
             proof.provider_terminal_response_sha256
               as "providerTerminalResponseSha256",
             proof.publish_artifact_attempt_id::text
               as "publishArtifactAttemptId",
             proof.local_completed_attempt_id::text
               as "localCompletedAttemptId",
             proof.local_completed_public_provider_release_id::text
               as "localCompletedPublicProviderReleaseId",
             proof.local_completed_provider_release_fingerprint
               as "localCompletedProviderReleaseFingerprint",
             proof.local_completed_terminal_receipt_sha256
               as "localCompletedTerminalReceiptSha256"
      from public.manifest_promotion_lanes as lane
      join public.catalog_promotion_bootstrap_provider_proofs as proof
        on proof.organization_id = lane.organization_id
       and proof.deployment_key = lane.deployment_key
       and proof.proof_revision = lane.current_bootstrap_proof_revision
      where lane.organization_id = ${uuid(binding.organizationId)}
        and lane.deployment_key = ${binding.deploymentKey}
      order by proof.ordinal
    `,
  );
  if (rows.length !== platformKeys.length || rows.some((row, index) =>
    row.ordinal !== index || row.platformKey !== platformKeys[index])) {
    return proofIncomplete();
  }

  const protections: CatalogRetentionExternalProviderProtection[] = [];
  for (const row of rows) {
    if (row.publicProviderReleaseId === null) {
      if (
        row.providerReleaseFingerprint !== null ||
        row.providerTerminalOperationId !== null ||
        row.providerTerminalReceiptBody !== null ||
        row.providerTerminalReceiptSha256 !== null ||
        row.providerTerminalResponseBody !== null ||
        row.providerTerminalResponseSha256 !== null ||
        row.publishArtifactAttemptId !== null
      ) return proofIncomplete();
    } else {
      if (
        row.providerReleaseFingerprint === null ||
        row.providerTerminalOperationId === null ||
        row.providerTerminalReceiptBody === null ||
        row.providerTerminalReceiptSha256 === null ||
        row.publishArtifactAttemptId === null ||
        promotionV2Sha256(row.providerTerminalReceiptBody) !==
          row.providerTerminalReceiptSha256 ||
        (row.providerTerminalResponseBody === null) !==
          (row.providerTerminalResponseSha256 === null)
      ) return proofIncomplete();
      protections.push(await loadExactBootstrapProviderProtection(
        transaction,
        binding,
        {
          release: {
            platformKey: row.platformKey,
            publicProviderReleaseId: row.publicProviderReleaseId,
            providerReleaseFingerprint: row.providerReleaseFingerprint,
          },
          operationPredicate:
            Prisma.sql`operation.platform_key = ${row.platformKey}
              and operation.operation_id = ${row.providerTerminalOperationId}
              and operation.state = 'acknowledged'
              and operation.receipt_sha256 =
                ${row.providerTerminalReceiptSha256}`,
          terminalReceiptSha256: row.providerTerminalReceiptSha256,
          storedActiveEvidence: {
            receiptBody: row.providerTerminalReceiptBody,
            responseBody: row.providerTerminalResponseBody,
            responseSha256: row.providerTerminalResponseSha256,
            publishArtifactAttemptId: row.publishArtifactAttemptId,
          },
        },
      ));
    }

    if (row.localCompletedAttemptId === null) {
      if (
        row.localCompletedPublicProviderReleaseId !== null ||
        row.localCompletedProviderReleaseFingerprint !== null ||
        row.localCompletedTerminalReceiptSha256 !== null
      ) return proofIncomplete();
      continue;
    }
    if (
      row.localCompletedPublicProviderReleaseId === null ||
      row.localCompletedProviderReleaseFingerprint === null ||
      row.localCompletedTerminalReceiptSha256 === null
    ) return proofIncomplete();
    protections.push(await loadExactBootstrapProviderProtection(
      transaction,
      binding,
      {
        release: {
          platformKey: row.platformKey,
          publicProviderReleaseId: row.localCompletedPublicProviderReleaseId,
          providerReleaseFingerprint:
            row.localCompletedProviderReleaseFingerprint,
        },
        operationPredicate:
          Prisma.sql`operation.platform_key = ${row.platformKey}
            and attempt.id = ${uuid(row.localCompletedAttemptId)}
            and operation.state = 'acknowledged'
            and operation.receipt_sha256 =
              ${row.localCompletedTerminalReceiptSha256}`,
        terminalReceiptSha256: row.localCompletedTerminalReceiptSha256,
        storedActiveEvidence: null,
      },
    ));
  }
  return protections;
}

async function loadCompletedHeads(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  platformKeys: readonly string[],
) {
  const rows = platformKeys.length === 0 ? [] : await transaction.$queryRaw<
    ProviderLaneProofRow[]
  >(Prisma.sql`
    select platform_key as "platformKey",
           completed_checkpoint as "completedCheckpoint",
           completed_head_body as "completedHeadBody",
           completed_head_sha256 as "completedHeadSha256",
           completed_terminal_operation_id as "completedTerminalOperationId",
           completed_terminal_receipt_sha256 as "completedTerminalReceiptSha256",
           completed_public_provider_release_id::text
             as "completedPublicProviderReleaseId",
           completed_provider_release_fingerprint
             as "completedProviderReleaseFingerprint",
           completed_terminal_operation_kind as "completedTerminalOperationKind",
           completed_attempt_id::text as "completedAttemptId"
    from public.provider_promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
      and platform_key in (${Prisma.join(platformKeys)})
    order by platform_key collate "C"
  `);
  const byPlatform = new Map(rows.map((row) => [row.platformKey, row]));
  const completedHeads: CatalogRetentionPostgresProofSnapshot["completedHeads"] = [];
  for (const platformKey of platformKeys) {
    const row = byPlatform.get(platformKey);
    if (!row || row.completedCheckpoint === 0n) {
      if (row && [row.completedHeadBody, row.completedHeadSha256,
        row.completedTerminalOperationId, row.completedTerminalReceiptSha256,
        row.completedPublicProviderReleaseId,
        row.completedProviderReleaseFingerprint,
        row.completedTerminalOperationKind, row.completedAttemptId]
        .some((value) => value !== null)) return proofIncomplete();
      completedHeads.push({
        platformKey,
        completedHead: {
          platformKey,
          publicProviderReleaseId: null,
          sharedConfigurationEpoch: null,
          providerCheckpoint: { settledSequence: "0" as const, settledAt: null },
          observation: null,
          terminalReceiptSha256: null,
        },
        terminalOperationId: null,
      });
      continue;
    }
    if (row.completedHeadBody === null || row.completedHeadSha256 === null ||
      row.completedTerminalOperationId === null ||
      row.completedTerminalReceiptSha256 === null ||
      row.completedPublicProviderReleaseId === null ||
      row.completedProviderReleaseFingerprint === null ||
      row.completedTerminalOperationKind === null ||
      row.completedAttemptId === null ||
      promotionV2Sha256(row.completedHeadBody) !== row.completedHeadSha256) {
      return proofIncomplete();
    }
    const completed = parseCanonical(
      row.completedHeadBody, providerReleaseCompletedHeadResultV1Schema,
    );
    if (completed.platformKey !== platformKey ||
      completed.providerCheckpoint.settledSequence !==
        String(row.completedCheckpoint)) return proofIncomplete();
    const operations = await loadProviderOperationRows(
      transaction,
      binding,
      Prisma.sql`operation.platform_key = ${platformKey}
        and operation.operation_id = ${row.completedTerminalOperationId}
        and operation.state = 'acknowledged'
        and operation.receipt_sha256 =
          ${row.completedTerminalReceiptSha256}`,
    );
    if (operations.length !== 1) return proofIncomplete();
    const operation = operations[0]!;
    const request = providerRequest(operation);
    validateProviderOperation(operation);
    if (
      operation.attemptId !== row.completedAttemptId ||
      operation.operationKind !== row.completedTerminalOperationKind ||
      completed.release.publicProviderReleaseId !==
        row.completedPublicProviderReleaseId ||
      completed.release.providerReleaseFingerprint !==
        row.completedProviderReleaseFingerprint ||
      canonicalJson(completed.release) !== canonicalJson(request.release)
    ) return proofIncomplete();
    completedHeads.push({
      platformKey,
      completedHead: providerReleaseExpectedCompletedHeadV1Schema.parse({
        platformKey,
        publicProviderReleaseId: completed.release.publicProviderReleaseId,
        sharedConfigurationEpoch: completed.release.sharedConfigurationEpoch,
        providerCheckpoint: completed.providerCheckpoint,
        observation: completed.observation,
        terminalReceiptSha256: row.completedTerminalReceiptSha256,
      }),
      terminalOperationId: row.completedTerminalOperationId,
    });
  }
  return completedHeads;
}

function sameManifestIdentity(
  left: Readonly<{
    publicReleaseId: string;
    manifestFingerprint: string;
    sharedConfigurationEpoch: unknown;
    providerReferenceSetHash: string;
  }>,
  right: Readonly<{
    publicReleaseId: string;
    manifestFingerprint: string;
    sharedConfigurationEpoch: unknown;
    providerReferenceSetHash: string;
  }>,
) {
  return canonicalJson(left) === canonicalJson(right);
}

async function loadManifestOperationRows(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  predicate: Prisma.Sql,
) {
  return transaction.$queryRaw<OperationProofRow[]>(Prisma.sql`
    select attempt.id::text as "attemptId", null::text as "platformKey",
           attempt.public_release_id::text as "publicReleaseId",
           attempt.manifest_fingerprint as fingerprint,
           attempt.prepared_summary_body as "preparedSummaryBody",
           attempt.state as "attemptState", attempt.terminal_at as "terminalAt",
           operation.operation_index as "operationIndex",
           operation.operation_id as "operationId",
           operation.operation_kind as "operationKind",
           operation.request_path as "requestPath",
           operation.canonical_request_body as "canonicalRequestBody",
           operation.request_sha256 as "requestSha256", operation.state,
           operation.state as "operationState",
           operation.send_count as "sendCount",
           operation.last_sent_at as "lastSentAt",
           operation.acknowledged_at as "acknowledgedAt",
           operation.canonical_receipt_body as "canonicalReceiptBody",
           operation.receipt_sha256 as "receiptSha256",
           operation.exact_response_body as "exactResponseBody",
           operation.response_sha256 as "responseSha256"
    from public.manifest_promotion_operations as operation
    join public.manifest_promotion_attempts as attempt
      on attempt.id = operation.attempt_id
     and attempt.organization_id = operation.organization_id
     and attempt.deployment_key = operation.deployment_key
    where operation.organization_id = ${uuid(binding.organizationId)}
      and operation.deployment_key = ${binding.deploymentKey}
      and ${predicate}
    order by operation.operation_id collate "C"
  `);
}

async function heatManifestProtection(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  source: Awaited<ReturnType<typeof parseHeatManifestSourceProof>>,
): Promise<CatalogRetentionExternalManifestProtection> {
  const terminal = await loadManifestOperationRows(
    transaction,
    binding,
    Prisma.sql`operation.state = 'acknowledged'
      and operation.receipt_sha256 = ${source.terminalReceiptSha256}`,
  );
  if (terminal.length !== 1) return proofIncomplete();
  validateManifestOperation(terminal[0]!);

  const definitions = await loadManifestOperationRows(
    transaction,
    binding,
    Prisma.sql`operation.state = 'acknowledged'
      and operation.operation_kind = 'activateManifest'
      and attempt.public_release_id =
        ${uuid(source.manifestAlignment.publicReleaseId)}
      and attempt.manifest_fingerprint =
        ${source.manifestAlignment.manifestFingerprint}`,
  );
  const definition = definitions.find((row) => {
    try {
      const identity = manifestIdentity(row);
      return identity !== null && sameManifestIdentity(
        identity, source.manifestAlignment,
      );
    } catch {
      return false;
    }
  });
  if (!definition) return proofIncomplete();
  return {
    manifest: source.manifestAlignment,
    reason: "in_flight_attempt",
    operationProof: validateManifestOperation(definition) as
      CatalogRetentionExternalManifestProtection["operationProof"],
  };
}

async function heatProviderProtection(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  reference: Awaited<ReturnType<typeof parseHeatManifestSourceProof>>[
    "providerReferences"
  ][number],
): Promise<CatalogRetentionExternalProviderProtection> {
  const rows = await transaction.$queryRaw<Array<OperationProofRow & {
    immutableProofBody: string;
    immutableProofSha256: string;
  }>>(Prisma.sql`
    select attempt.id::text as "attemptId",
           attempt.platform_key as "platformKey",
           attempt.public_provider_release_id::text as "publicReleaseId",
           attempt.provider_release_fingerprint as fingerprint,
           attempt.prepared_summary_body as "preparedSummaryBody",
           operation.operation_index as "operationIndex",
           operation.operation_id as "operationId",
           operation.operation_kind as "operationKind",
           operation.request_path as "requestPath",
           operation.canonical_request_body as "canonicalRequestBody",
           operation.request_sha256 as "requestSha256", operation.state,
           operation.state as "operationState",
           operation.send_count as "sendCount",
           operation.last_sent_at as "lastSentAt",
           operation.acknowledged_at as "acknowledgedAt",
           operation.canonical_receipt_body as "canonicalReceiptBody",
           operation.receipt_sha256 as "receiptSha256",
           operation.exact_response_body as "exactResponseBody",
           operation.response_sha256 as "responseSha256",
           artifact.immutable_proof_body as "immutableProofBody",
           artifact.immutable_proof_sha256 as "immutableProofSha256"
    from public.provider_release_artifacts as artifact
    join public.provider_promotion_attempts as attempt
      on attempt.id = artifact.publish_attempt_id
     and attempt.organization_id = artifact.organization_id
     and attempt.deployment_key = artifact.deployment_key
     and attempt.platform_key = artifact.platform_key
    join public.provider_promotion_operations as operation
      on operation.attempt_id = attempt.id
     and operation.organization_id = attempt.organization_id
     and operation.deployment_key = attempt.deployment_key
     and operation.platform_key = attempt.platform_key
    where artifact.organization_id = ${uuid(binding.organizationId)}
      and artifact.deployment_key = ${binding.deploymentKey}
      and artifact.platform_key = ${reference.platformKey}
      and artifact.public_provider_release_id =
        ${uuid(reference.publicProviderReleaseId)}
      and artifact.provider_release_fingerprint =
        ${reference.providerReleaseFingerprint}
      and operation.operation_kind = 'finalize'
      and operation.state = 'acknowledged'
    order by operation.operation_id collate "C"
  `);
  const row = rows[0];
  if (rows.length !== 1 || !row ||
    promotionV2Sha256(row.immutableProofBody) !== row.immutableProofSha256) {
    return proofIncomplete();
  }
  const immutableProof = parseCanonical(
    row.immutableProofBody, providerReleaseImmutableProofV1Schema,
  );
  if (canonicalJson(immutableProof) !== canonicalJson(reference)) {
    return proofIncomplete();
  }
  return {
    release: providerIdentity(row),
    reason: "in_flight_attempt",
    operationProof: validateProviderOperation(row) as
      CatalogRetentionExternalProviderProtection["operationProof"],
  };
}

async function loadHeatAttemptProtections(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
) {
  const attempts = await transaction.$queryRaw<Array<{
    manifestSourceProofBody: string | null;
    manifestSourceProofSha256: string | null;
  }>>(Prisma.sql`
    select manifest_source_proof_body as "manifestSourceProofBody",
           manifest_source_proof_sha256 as "manifestSourceProofSha256"
    from public.promotion_attempts
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
      and lane_key = 'heat'
      and state in ('assembling', 'ready', 'in_progress', 'retry_wait')
    order by target_watermark, id
  `);
  const manifestProtections: CatalogRetentionExternalManifestProtection[] = [];
  const providerProtections: CatalogRetentionExternalProviderProtection[] = [];
  for (const attempt of attempts) {
    if (attempt.manifestSourceProofBody === null &&
      attempt.manifestSourceProofSha256 === null) continue;
    if (attempt.manifestSourceProofBody === null ||
      attempt.manifestSourceProofSha256 === null) return proofIncomplete();
    let source;
    try {
      source = await parseHeatManifestSourceProof(
        attempt.manifestSourceProofBody,
        attempt.manifestSourceProofSha256,
      );
    } catch {
      return proofIncomplete();
    }
    manifestProtections.push(await heatManifestProtection(
      transaction, binding, source,
    ));
    for (const reference of source.providerReferences) {
      providerProtections.push(await heatProviderProtection(
        transaction, binding, reference,
      ));
    }
  }
  return { manifestProtections, providerProtections };
}

async function loadOperationProtections(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  evaluatedAt: Date,
  platformKeys: readonly string[],
) {
  const recoveryCutoff = new Date(
    evaluatedAt.getTime() - CATALOG_RETENTION_COMPLETE_MILLISECONDS,
  );
  const providerRows = await transaction.$queryRaw<OperationProofRow[]>(Prisma.sql`
    select attempt.id::text as "attemptId", attempt.platform_key as "platformKey",
           attempt.public_provider_release_id::text as "publicReleaseId",
           attempt.provider_release_fingerprint as fingerprint,
           attempt.prepared_summary_body as "preparedSummaryBody",
           attempt.state as "attemptState", attempt.terminal_at as "terminalAt",
           operation.operation_index as "operationIndex",
           operation.operation_id as "operationId",
           operation.operation_kind as "operationKind",
           operation.request_path as "requestPath",
           operation.canonical_request_body as "canonicalRequestBody",
           operation.request_sha256 as "requestSha256",
           operation.state,
           operation.state as "operationState",
           operation.send_count as "sendCount",
           operation.last_sent_at as "lastSentAt",
           operation.acknowledged_at as "acknowledgedAt",
           operation.canonical_receipt_body as "canonicalReceiptBody",
           operation.receipt_sha256 as "receiptSha256",
           operation.exact_response_body as "exactResponseBody",
           operation.response_sha256 as "responseSha256"
    from public.provider_promotion_attempts as attempt
    left join public.provider_promotion_operations as operation
      on operation.attempt_id = attempt.id
    where attempt.organization_id = ${uuid(binding.organizationId)}
      and attempt.deployment_key = ${binding.deploymentKey}
      and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
    order by attempt.platform_key collate "C", attempt.evaluation_sequence,
             operation.operation_index
  `);
  const providerGroups = new Map<string, CatalogRetentionExternalProviderProtection[]>();
  const providerAttempts = new Map<string, OperationProofRow[]>();
  for (const row of providerRows) {
    const rows = providerAttempts.get(row.attemptId) ?? [];
    rows.push(row);
    providerAttempts.set(row.attemptId, rows);
  }
  for (const rows of providerAttempts.values()) {
    const first = rows[0]!;
    if (!first.operationId) {
      if (rows.length !== 1 || first.publicReleaseId !== null) {
        return proofIncomplete();
      }
      continue;
    }
    const protection = validateProviderAttemptRows(rows);
    const release = protection.release;
    const group = providerGroups.get(release.platformKey) ?? [];
    group.push(protection);
    providerGroups.set(release.platformKey, group);
  }
  for (const protection of await loadCurrentBootstrapProviderProtections(
    transaction,
    binding,
    platformKeys,
  )) {
    const group = providerGroups.get(protection.release.platformKey) ?? [];
    group.push(protection);
    providerGroups.set(protection.release.platformKey, group);
  }

  const manifestRows = await transaction.$queryRaw<OperationProofRow[]>(Prisma.sql`
    select attempt.id::text as "attemptId", null::text as "platformKey",
           attempt.public_release_id::text as "publicReleaseId",
           attempt.manifest_fingerprint as fingerprint,
           attempt.prepared_summary_body as "preparedSummaryBody",
           attempt.state as "attemptState", attempt.terminal_at as "terminalAt",
           operation.operation_index as "operationIndex",
           operation.operation_id as "operationId",
           operation.operation_kind as "operationKind",
           operation.request_path as "requestPath",
           operation.canonical_request_body as "canonicalRequestBody",
           operation.request_sha256 as "requestSha256",
           operation.state,
           operation.state as "operationState",
           operation.send_count as "sendCount",
           operation.last_sent_at as "lastSentAt",
           operation.acknowledged_at as "acknowledgedAt",
           operation.canonical_receipt_body as "canonicalReceiptBody",
           operation.receipt_sha256 as "receiptSha256",
           operation.exact_response_body as "exactResponseBody",
           operation.response_sha256 as "responseSha256"
    from public.manifest_promotion_attempts as attempt
    left join public.manifest_promotion_operations as operation
      on operation.attempt_id = attempt.id
    where attempt.organization_id = ${uuid(binding.organizationId)}
      and attempt.deployment_key = ${binding.deploymentKey}
      and (
        attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
        or (attempt.state in ('blocked', 'rolled_back')
          and attempt.terminal_at > ${recoveryCutoff})
      )
    order by attempt.evaluation_sequence, operation.operation_index
  `);
  const manifestProtections: CatalogRetentionExternalManifestProtection[] = [];
  for (const row of manifestRows) {
    if (!row.operationId) {
      if (row.publicReleaseId !== null) return proofIncomplete();
      continue;
    }
    if (row.operationKind === "refreshActiveState") continue;
    const manifest = manifestIdentity(row);
    if (manifest === null) continue;
    const reason = row.operationState === "acknowledged" &&
        row.operationKind === "block"
      ? "block_recovery" as const
      : row.operationState === "acknowledged" &&
          (row.operationKind === "activateManifest" ||
            row.operationKind === "rollback")
      ? "rollback_recovery" as const
      : "in_flight_attempt" as const;
    manifestProtections.push({
      manifest,
      reason,
      operationProof: validateManifestOperation(row) as
        CatalogRetentionExternalManifestProtection["operationProof"],
    });
  }
  const heat = await loadHeatAttemptProtections(transaction, binding);
  manifestProtections.push(...heat.manifestProtections);
  for (const protection of heat.providerProtections) {
    const group = providerGroups.get(protection.release.platformKey) ?? [];
    group.push(protection);
    providerGroups.set(protection.release.platformKey, group);
  }

  const uniqueManifestProtections = [...new Map(manifestProtections.map(
    (protection) => [[
      protection.manifest.publicReleaseId, protection.reason,
      protection.operationProof.operationId,
    ].join("\n"), protection] as const,
  )).values()];
  uniqueManifestProtections.sort((left, right) => {
    const a = [left.manifest.publicReleaseId, left.reason,
      left.operationProof.operationId].join("\n");
    const b = [right.manifest.publicReleaseId, right.reason,
      right.operationProof.operationId].join("\n");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const providerProtectionsByPlatform = [...providerGroups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([platformKey, releases]) => ({
      platformKey,
      releases: [...new Map(releases.map((protection) => [[
        protection.release.publicProviderReleaseId, protection.reason,
        protection.operationProof.operationId,
      ].join("\n"), protection] as const)).values()].sort((left, right) => {
        const a = [left.release.publicProviderReleaseId, left.reason,
          left.operationProof.operationId].join("\n");
        const b = [right.release.publicProviderReleaseId, right.reason,
          right.operationProof.operationId].join("\n");
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    }));
  return {
    manifestProtections: uniqueManifestProtections,
    providerProtectionsByPlatform,
  };
}

export async function loadCatalogPromotionRetentionProof(
  transaction: PackscoutTransactionClient,
  binding: CatalogPromotionRetentionScopeBinding,
  input: Readonly<{
    snapshotId: string;
    snapshotSequence: bigint;
    evaluatedAt: Date;
  }>,
): Promise<CatalogRetentionPostgresProofSnapshot> {
  const lanes = await transaction.$queryRaw<ManifestLaneProofRow[]>(Prisma.sql`
    select bootstrap_state as "bootstrapState",
           bootstrap_provider_set_body as "bootstrapProviderSetBody",
           bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
           active_generation as "activeGeneration",
           active_state_body as "activeStateBody",
           active_state_sha256 as "activeStateSha256",
           active_terminal_receipt_sha256 as "activeTerminalReceiptSha256",
           active_public_release_id::text as "activePublicReleaseId",
           active_manifest_fingerprint as "activeManifestFingerprint",
           active_provider_reference_set_hash
             as "activeProviderReferenceSetHash",
           active_configuration_epoch_sequence
             as "activeConfigurationEpochSequence"
    from public.manifest_promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
  `);
  const lane = lanes[0];
  if (!lane || lane.bootstrapState === "unverified" ||
    lane.bootstrapProviderSetBody === null ||
    lane.bootstrapProviderSetSha256 === null) return proofIncomplete();
  const platformKeys = parseCatalogPromotionRetentionPlatformKeys(
    lane.bootstrapProviderSetBody, lane.bootstrapProviderSetSha256,
  );
  const [activeState, completedHeads, protections] = await Promise.all([
    loadActiveState(transaction, binding, lane),
    loadCompletedHeads(transaction, binding, platformKeys),
    loadOperationProtections(
      transaction,
      binding,
      input.evaluatedAt,
      platformKeys,
    ),
  ]);
  const withoutDigest = {
    snapshotId: input.snapshotId,
    snapshotSequence: String(input.snapshotSequence),
    evaluatedAt: input.evaluatedAt.toISOString(),
    activeState,
    completedHeads,
    manifestProtections: protections.manifestProtections,
    providerProtectionsByPlatform:
      protections.providerProtectionsByPlatform,
  };
  const snapshot = {
    ...withoutDigest,
    snapshotDigest: await catalogRetentionPostgresProofSnapshotDigest(
      withoutDigest,
    ),
  };
  try {
    return catalogRetentionPostgresProofSnapshotSchema.parse(snapshot);
  } catch {
    return proofIncomplete();
  }
}
