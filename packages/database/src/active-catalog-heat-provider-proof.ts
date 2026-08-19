import {
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  canonicalJson,
  globalCatalogProviderActiveObservationV1Schema,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseReceiptDigest,
  providerReleaseStartRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseImmutableProofV1Schema,
  recomputeGlobalCatalogCompositionProofHashV1,
  verifyProviderCatalogReleasePlanV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderReferenceV1,
  type ProviderCatalogReleasePublishPlanV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";
import {
  parseProviderPromotionPreparedSummary,
  parseProviderPromotionReceiptEvidence,
  validateProviderPromotionPrepared,
  type ProviderPromotionOperationRow,
} from "./provider-promotion-repository-validation.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";
import { parseProviderCheckpointIdentityBody } from "./promotion-v2-types.ts";

const sha256Pattern = /^[0-9a-f]{64}$/u;

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function invalidProof(): never {
  throw new Error("Promotion release proof is invalid.");
}

interface ActiveSelectionProofRow {
  platformKey: string;
  activeGeneration: bigint;
  manifestPublicReleaseId: string;
  providerPublicReleaseId: string;
  providerReleaseFingerprint: string;
  selectedCheckpoint: bigint;
  selectionBody: string;
  selectionSha256: string;
  providerTerminalOperationId: string;
  providerTerminalReceiptSha256: string;
  publishArtifactAttemptId: string;
  immutableProofBody: string;
  immutableProofSha256: string;
}

interface ProviderAttemptProofRow {
  id: string;
  platformKey: string;
  targetCheckpoint: bigint;
  state: string;
  preparedClassification: string | null;
  preparedSummaryBody: string | null;
  preparedSummarySha256: string | null;
  publicProviderReleaseId: string | null;
  providerReleaseFingerprint: string | null;
  checkpointBody: string;
  checkpointSha256: string;
}

interface ProviderOperationProofRow extends ProviderPromotionOperationRow {
  attemptId: string;
}

export interface ActiveCatalogPublicRepackOwnership {
  readonly publicRepackId: string;
  readonly platformKey: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
}

interface ProvenProviderAttempt {
  readonly classification: "publish" | "reuse";
  readonly reference: GlobalCatalogProviderReferenceV1;
  readonly targetCheckpoint: bigint;
  readonly selectedProviderCheckpoint: Readonly<{
    settledSequence: string;
    settledAt: string | null;
  }>;
  readonly terminalOperationId: string;
  readonly terminalReceiptSha256: string;
  readonly publishPlan: ProviderCatalogReleasePublishPlanV1 | null;
}

function requestInput(operation: ProviderOperationProofRow) {
  return {
    operationIndex: operation.operationIndex,
    operationId: operation.operationId,
    operationKind: operation.operationKind,
    requestPath: operation.requestPath,
    canonicalRequestBody: operation.canonicalRequestBody,
  };
}

async function loadProviderAttempt(
  database: PackscoutQueryClient,
  binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  attemptId: string,
): Promise<ProvenProviderAttempt> {
  const attempts = await database.$queryRaw<ProviderAttemptProofRow[]>(Prisma.sql`
    select attempt.id::text as id, attempt.platform_key as "platformKey",
           attempt.target_checkpoint as "targetCheckpoint", attempt.state,
           attempt.prepared_classification as "preparedClassification",
           attempt.prepared_summary_body as "preparedSummaryBody",
           attempt.prepared_summary_sha256 as "preparedSummarySha256",
           attempt.public_provider_release_id::text as "publicProviderReleaseId",
           attempt.provider_release_fingerprint as "providerReleaseFingerprint",
           evaluation.checkpoint_body as "checkpointBody",
           evaluation.checkpoint_sha256 as "checkpointSha256"
    from public.provider_promotion_attempts as attempt
    join public.provider_promotion_evaluations as evaluation
      on evaluation.organization_id = attempt.organization_id
     and evaluation.deployment_key = attempt.deployment_key
     and evaluation.platform_key = attempt.platform_key
     and evaluation.evaluation_sequence = attempt.evaluation_sequence
    where attempt.id = ${uuid(attemptId)}
      and attempt.organization_id = ${uuid(binding.organizationId)}
      and attempt.deployment_key = ${binding.deploymentKey}
  `);
  const attempt = attempts[0];
  if (
    attempts.length !== 1 || !attempt ||
    attempt.preparedSummaryBody === null ||
    attempt.preparedSummarySha256 === null ||
    promotionV2Sha256(attempt.preparedSummaryBody) !==
      attempt.preparedSummarySha256 ||
    promotionV2Sha256(attempt.checkpointBody) !== attempt.checkpointSha256 ||
    !["published", "reused"].includes(attempt.state)
  ) invalidProof();

  const operations = await database.$queryRaw<ProviderOperationProofRow[]>(
    Prisma.sql`
      select operation.attempt_id::text as "attemptId",
             operation.operation_index as "operationIndex",
             operation.operation_id as "operationId",
             operation.operation_kind as "operationKind",
             operation.request_path as "requestPath",
             operation.canonical_request_body as "canonicalRequestBody",
             operation.request_sha256 as "requestSha256", operation.state,
             operation.send_count as "sendCount",
             operation.last_sent_at as "lastSentAt",
             operation.acknowledged_at as "acknowledgedAt",
             operation.canonical_receipt_body as "canonicalReceiptBody",
             operation.receipt_sha256 as "receiptSha256",
             operation.exact_response_body as "exactResponseBody",
             operation.response_sha256 as "responseSha256"
      from public.provider_promotion_operations as operation
      where operation.attempt_id = ${uuid(attemptId)}
        and operation.organization_id = ${uuid(binding.organizationId)}
        and operation.deployment_key = ${binding.deploymentKey}
        and operation.platform_key = ${attempt.platformKey}
      order by operation.operation_index
    `,
  );
  if (
    operations.length === 0 ||
    operations.some((operation, index) =>
      operation.attemptId !== attempt.id ||
      operation.operationIndex !== index ||
      operation.state !== "acknowledged" ||
      operation.canonicalReceiptBody === null ||
      operation.receiptSha256 === null ||
      promotionV2Sha256(operation.canonicalRequestBody) !==
        operation.requestSha256 ||
      promotionV2Sha256(operation.canonicalReceiptBody) !==
        operation.receiptSha256 ||
      (operation.exactResponseBody === null) !==
        (operation.responseSha256 === null) ||
      (operation.exactResponseBody !== null &&
        promotionV2Sha256(operation.exactResponseBody) !==
          operation.responseSha256))
  ) invalidProof();

  let summary;
  try {
    summary = parseProviderPromotionPreparedSummary(
      attempt.preparedSummaryBody,
    );
    validateProviderPromotionPrepared(
      attempt.platformKey,
      attempt.targetCheckpoint,
      attempt.checkpointBody,
      attempt.checkpointSha256,
      summary,
      operations.map(requestInput),
    );
  } catch {
    invalidProof();
  }
  if (
    summary.classification !== attempt.preparedClassification ||
    attempt.state !== (summary.classification === "publish"
      ? "published" : "reused") ||
    attempt.publicProviderReleaseId !== summary.publicProviderReleaseId ||
    attempt.providerReleaseFingerprint !==
      summary.providerReleaseFingerprint
  ) invalidProof();

  for (const operation of operations) {
    let parsed;
    try {
      parsed = parseProviderPromotionReceiptEvidence(operation, {
        canonicalReceiptBody: operation.canonicalReceiptBody!,
        exactResponseBody: operation.exactResponseBody,
      });
    } catch {
      invalidProof();
    }
    if (
      parsed.receiptSha256 !== operation.receiptSha256 ||
      parsed.responseSha256 !== operation.responseSha256 ||
      await providerReleaseReceiptDigest(parsed.receipt) !==
        parsed.receipt.receiptDigest
    ) invalidProof();
  }

  const terminal = operations.at(-1)!;
  let publishPlan: ProviderCatalogReleasePublishPlanV1 | null = null;
  if (summary.classification === "publish") {
    let start;
    let finalize;
    let batches;
    try {
      start = providerReleaseStartRequestSchema.parse(
        JSON.parse(operations[0]!.canonicalRequestBody) as unknown,
      );
      finalize = providerReleaseFinalizeRequestSchema.parse(
        JSON.parse(terminal.canonicalRequestBody) as unknown,
      );
      batches = operations.slice(1, -1).map((operation) =>
        providerReleaseApplyBatchRequestSchema.parse(
          JSON.parse(operation.canonicalRequestBody) as unknown,
        ).batch
      );
    } catch {
      invalidProof();
    }
    if (
      terminal.operationKind !== "finalize" ||
      canonicalJson(start.release) !==
        canonicalJson(summary.immutableProof) ||
      canonicalJson(finalize.release) !==
        canonicalJson(summary.immutableProof)) invalidProof();
    try {
      const verified = await verifyProviderCatalogReleasePlanV1({
        schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
        classification: "publish",
        ...start.release,
        providerCheckpoint: start.providerCheckpoint,
        sourceWatermark: start.sourceWatermark,
        observation: start.observation,
        batches,
      });
      if (verified.classification !== "publish") invalidProof();
      publishPlan = verified;
    } catch {
      invalidProof();
    }
  }

  return {
    classification: summary.classification,
    reference: providerReleaseImmutableProofV1Schema.parse(
      summary.immutableProof,
    ),
    targetCheckpoint: attempt.targetCheckpoint,
    selectedProviderCheckpoint: (() => {
      let checkpoint;
      try {
        checkpoint = parseProviderCheckpointIdentityBody(
          attempt.checkpointBody,
        );
      } catch {
        invalidProof();
      }
      return Object.freeze({
        settledSequence: String(checkpoint.settledSequence),
        settledAt: checkpoint.settledAt?.toISOString() ?? null,
      });
    })(),
    terminalOperationId: terminal.operationId,
    terminalReceiptSha256: terminal.receiptSha256!,
    publishPlan,
  };
}

export async function proveActiveCatalogProviderRepacks(
  database: PackscoutQueryClient,
  binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  input: Readonly<{
    manifest: GlobalCatalogManifestV1;
    activeGeneration: bigint;
    activeSelections: readonly unknown[];
  }>,
): Promise<Readonly<{
  publicRepackOwnership: readonly ActiveCatalogPublicRepackOwnership[];
  publicRepackIds: readonly string[];
}>> {
  const rows = await database.$queryRaw<ActiveSelectionProofRow[]>(Prisma.sql`
    select selection.platform_key as "platformKey",
           selection.active_generation as "activeGeneration",
           selection.manifest_public_release_id::text as "manifestPublicReleaseId",
           selection.provider_public_release_id::text as "providerPublicReleaseId",
           selection.provider_release_fingerprint as "providerReleaseFingerprint",
           selection.selected_checkpoint as "selectedCheckpoint",
           selection.selection_body as "selectionBody",
           selection.selection_sha256 as "selectionSha256",
           selection.provider_terminal_operation_id as "providerTerminalOperationId",
           selection.provider_terminal_receipt_sha256
             as "providerTerminalReceiptSha256",
           selection.publish_artifact_attempt_id::text
             as "publishArtifactAttemptId",
           artifact.immutable_proof_body as "immutableProofBody",
           artifact.immutable_proof_sha256 as "immutableProofSha256"
    from public.manifest_active_provider_selections as selection
    join public.provider_release_artifacts as artifact
      on artifact.publish_attempt_id = selection.publish_artifact_attempt_id
     and artifact.organization_id = selection.organization_id
     and artifact.deployment_key = selection.deployment_key
     and artifact.platform_key = selection.platform_key
     and artifact.public_provider_release_id =
       selection.provider_public_release_id
     and artifact.provider_release_fingerprint =
       selection.provider_release_fingerprint
    where selection.organization_id = ${uuid(binding.organizationId)}
      and selection.deployment_key = ${binding.deploymentKey}
    order by selection.platform_key collate "C"
  `);
  if (
    rows.length !== input.manifest.providerReferences.length ||
    rows.length !== input.activeSelections.length
  ) invalidProof();

  const ownership: ActiveCatalogPublicRepackOwnership[] = [];
  for (const [index, row] of rows.entries()) {
    const reference = input.manifest.providerReferences[index];
    if (!reference ||
      row.platformKey !== reference.platformKey ||
      row.activeGeneration !== input.activeGeneration ||
      row.manifestPublicReleaseId !== input.manifest.publicReleaseId ||
      row.providerPublicReleaseId !== reference.publicProviderReleaseId ||
      row.providerReleaseFingerprint !==
        reference.providerReleaseFingerprint ||
      !sha256Pattern.test(row.providerTerminalReceiptSha256) ||
      promotionV2Sha256(row.selectionBody) !== row.selectionSha256 ||
      promotionV2Sha256(row.immutableProofBody) !== row.immutableProofSha256) {
      invalidProof();
    }
    let selection;
    let immutableProof;
    try {
      selection = globalCatalogProviderActiveObservationV1Schema.parse(
        JSON.parse(row.selectionBody) as unknown,
      );
      immutableProof = providerReleaseImmutableProofV1Schema.parse(
        JSON.parse(row.immutableProofBody) as unknown,
      );
    } catch {
      invalidProof();
    }
    if (
      canonicalJson(selection) !== row.selectionBody ||
      canonicalJson(selection) !== canonicalJson(input.activeSelections[index]) ||
      canonicalJson(immutableProof) !== row.immutableProofBody ||
      canonicalJson(immutableProof) !== canonicalJson(reference)
    ) invalidProof();

    const publish = await loadProviderAttempt(
      database, binding, row.publishArtifactAttemptId,
    );
    if (publish.classification !== "publish" || publish.publishPlan === null ||
      canonicalJson(publish.reference) !== canonicalJson(reference)) {
      invalidProof();
    }
    const terminalRows = await database.$queryRaw<Array<{
      attemptId: string;
    }>>(Prisma.sql`
      select operation.attempt_id::text as "attemptId"
      from public.provider_promotion_operations as operation
      where operation.organization_id = ${uuid(binding.organizationId)}
        and operation.deployment_key = ${binding.deploymentKey}
        and operation.platform_key = ${row.platformKey}
        and operation.operation_id = ${row.providerTerminalOperationId}
        and operation.receipt_sha256 = ${row.providerTerminalReceiptSha256}
        and operation.state = 'acknowledged'
    `);
    if (terminalRows.length !== 1) invalidProof();
    const selected = await loadProviderAttempt(
      database, binding, terminalRows[0]!.attemptId,
    );
    if (
      selected.terminalOperationId !== row.providerTerminalOperationId ||
      selected.terminalReceiptSha256 !== row.providerTerminalReceiptSha256 ||
      selected.targetCheckpoint !== row.selectedCheckpoint ||
      canonicalJson(selection.selectedProviderCheckpoint) !==
        canonicalJson(selected.selectedProviderCheckpoint) ||
      selection.terminalOperationKind !==
        (selected.classification === "publish" ? "finalize" : "confirmReuse") ||
      canonicalJson(selected.reference) !== canonicalJson(reference)
    ) invalidProof();

    for (const batch of publish.publishPlan.batches) {
      if (batch.kind !== "repacks") continue;
      for (const repack of batch.records) {
        ownership.push(Object.freeze({
          publicRepackId: repack.publicRepackId,
          platformKey: reference.platformKey,
          publicProviderReleaseId: reference.publicProviderReleaseId,
          providerReleaseFingerprint: reference.providerReleaseFingerprint,
        }));
      }
    }
  }

  if (
    ownership.length !== input.manifest.counts.repacks ||
    await recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_repack_ownership",
      canonicalProof: ownership.map(({ platformKey, publicRepackId }) => ({
        platformKey,
        publicRepackId,
      })),
    }) !== input.manifest.compositionProof.uniqueRepackOwnershipHash
  ) invalidProof();
  const publicRepackIds = ownership.map(({ publicRepackId }) => publicRepackId)
    .sort();
  if (publicRepackIds.some((id, index) =>
    index > 0 && id === publicRepackIds[index - 1])) invalidProof();
  return Object.freeze({
    publicRepackOwnership: Object.freeze(ownership),
    publicRepackIds: Object.freeze(publicRepackIds),
  });
}
