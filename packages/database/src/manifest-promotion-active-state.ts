import {
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  parseCatalogManifestPublicationJson,
  providerReleaseImmutableProofV1Schema,
  providerReleaseReceiptSchema,
  type ActiveCatalogManifestStateV1,
  type GlobalCatalogProviderReferenceV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import { manifestPointerIdentity } from
  "./manifest-promotion-repository-validation.ts";
import {
  PromotionV2PersistenceError,
  promotionV2Sha256,
  type ManifestPromotionActiveSelection,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";
import { lockPromotionConfigurationScope } from
  "./promotion-v2-bootstrap-proof-guard.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export interface ManifestPromotionActiveStateReplacement {
  readonly state: ActiveCatalogManifestStateV1;
  readonly canonicalStateBody: string;
  readonly stateReceiptBody: string;
  readonly stateReceiptSha256: string;
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
  readonly reconciledAt: Date;
  readonly activationOccurred: boolean;
}

export async function replaceManifestPromotionActiveState(
  transaction: PackscoutTransactionClient,
  binding: PromotionV2ScopeBinding,
  input: ManifestPromotionActiveStateReplacement,
  loadSelections: () => Promise<readonly ManifestPromotionActiveSelection[]>,
): Promise<void> {
  const loadProvenSelections = async () => {
    try {
      return await loadSelections();
    } catch (error) {
      if (error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_STATE_CONFLICT") {
        throw new PromotionV2PersistenceError(
          "PROMOTION_V2_ACTIVE_STATE_UNPROVEN",
        );
      }
      throw error;
    }
  };
  await lockPromotionConfigurationScope(transaction, binding);
  const parsed = activeCatalogManifestStateV1Schema.parse(input.state);
  if (canonicalJson(parsed) !== input.canonicalStateBody ||
    promotionV2Sha256(input.stateReceiptBody) !== input.stateReceiptSha256) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
  }
  const laneRows = await transaction.$queryRaw<Array<{
    activeGeneration: bigint;
    activeStateBody: string | null;
  }>>(Prisma.sql`
    select active_generation as "activeGeneration",
           active_state_body as "activeStateBody"
    from public.manifest_promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
    for update
  `);
  const lane = laneRows[0];
  if (!lane) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_ACTIVE_STATE_UNPROVEN");
  }
  const incomingGeneration = BigInt(parsed.generation);
  if (incomingGeneration < lane.activeGeneration) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_PREDECESSOR_CONFLICT");
  }
  if (incomingGeneration === lane.activeGeneration) {
    if (lane.activeStateBody !== input.canonicalStateBody) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_ACTIVE_STATE_UNPROVEN");
    }
    const persistedSelections = await loadProvenSelections();
    const observedSelections = parsed.observation?.providerSelections ?? [];
    if (persistedSelections.length !== observedSelections.length ||
      persistedSelections.some((selection, index) =>
        canonicalJson(selection.selection) !==
          canonicalJson(observedSelections[index]))) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_ACTIVE_STATE_UNPROVEN");
    }
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set active_state_receipt_body = ${input.stateReceiptBody},
          active_state_receipt_sha256 = ${input.stateReceiptSha256},
          active_state_response_body = ${input.exactResponseBody},
          active_state_response_sha256 = ${input.responseSha256},
          last_reconciled_at = ${input.reconciledAt},
          updated_at = ${input.reconciledAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
    `);
    return;
  }

  const active = parsed.activeManifest;
  const selections = parsed.observation?.providerSelections ?? [];
  let references: readonly GlobalCatalogProviderReferenceV1[] = [];
  if (active !== null) {
    const definitionRows = await transaction.$queryRaw<Array<{
      requestBody: string;
    }>>(Prisma.sql`
      select operation.canonical_request_body as "requestBody"
      from public.manifest_promotion_operations as operation
      join public.manifest_promotion_attempts as attempt
        on attempt.id = operation.attempt_id
       and attempt.organization_id = operation.organization_id
       and attempt.deployment_key = operation.deployment_key
      where operation.organization_id = ${uuid(binding.organizationId)}
        and operation.deployment_key = ${binding.deploymentKey}
        and operation.operation_kind = 'activateManifest'
        and operation.state = 'acknowledged'
        and attempt.public_release_id = ${uuid(active.publicReleaseId)}
      union all
      select proof.manifest_definition_request_body as "requestBody"
      from public.catalog_promotion_bootstrap_proofs as proof
      where proof.organization_id = ${uuid(binding.organizationId)}
        and proof.deployment_key = ${binding.deploymentKey}
        and proof.manifest_definition_request_body is not null
    `);
    const definitions = definitionRows.flatMap(({ requestBody }) => {
      try {
        const request = parseCatalogManifestPublicationJson(
          requestBody,
          catalogManifestActivateRequestSchema,
        );
        if (request === null) return [];
        return canonicalJson(manifestPointerIdentity(request.manifest)) ===
            canonicalJson(manifestPointerIdentity(active))
          ? [request.manifest] : [];
      } catch {
        return [];
      }
    });
    if (definitions.length === 0 || definitions.some((definition) =>
      canonicalJson(definition) !== canonicalJson(definitions[0]))) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_PREDECESSOR_CONFLICT");
    }
    const definition = definitions[0]!;
    if (definition.providerReferences.length !== selections.length) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_PREDECESSOR_CONFLICT");
    }
    references = definition.providerReferences;
  } else if (selections.length !== 0) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_ACTIVE_STATE_UNPROVEN");
  }

  const previousSelections = new Map(
    (await loadProvenSelections()).map((selection) => [
      selection.platformKey, selection,
    ]),
  );
  const resolved: Array<{
    selection: typeof selections[number];
    fingerprint: string;
    artifactAttemptId: string;
    activatedAt: Date;
  }> = [];
  for (const [index, selection] of selections.entries()) {
    const reference = references[index];
    if (!reference || reference.platformKey !== selection.platformKey ||
      reference.publicProviderReleaseId !== selection.publicProviderReleaseId ||
      reference.dataAsOf !== selection.selectedDataAsOf) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_PREDECESSOR_CONFLICT");
    }
    const rows = await transaction.$queryRaw<Array<{
      fingerprint: string;
      artifactAttemptId: string;
      immutableProofBody: string;
      immutableProofSha256: string;
      requestBody: string;
      requestSha256: string;
      receiptBody: string;
    }>>(Prisma.sql`
      select artifact.provider_release_fingerprint as fingerprint,
             artifact.publish_attempt_id::text as "artifactAttemptId",
             artifact.immutable_proof_body as "immutableProofBody",
             artifact.immutable_proof_sha256 as "immutableProofSha256",
             operation.canonical_request_body as "requestBody",
             operation.request_sha256 as "requestSha256",
             operation.canonical_receipt_body as "receiptBody"
      from public.provider_release_artifacts as artifact
      join public.provider_promotion_operations as operation
        on operation.organization_id = artifact.organization_id
       and operation.deployment_key = artifact.deployment_key
       and operation.platform_key = artifact.platform_key
       and operation.operation_id = ${selection.terminalOperationId}
       and operation.operation_kind = ${selection.terminalOperationKind}
       and operation.receipt_sha256 = ${selection.terminalReceiptSha256}
       and operation.state = 'acknowledged'
      where artifact.organization_id = ${uuid(binding.organizationId)}
        and artifact.deployment_key = ${binding.deploymentKey}
        and artifact.platform_key = ${selection.platformKey}
        and artifact.public_provider_release_id = ${uuid(
          selection.publicProviderReleaseId,
        )}
        and artifact.provider_release_fingerprint = ${
          reference.providerReleaseFingerprint
        }
    `);
    const row = rows[0];
    if (!row || promotionV2Sha256(row.immutableProofBody) !==
      row.immutableProofSha256 ||
      promotionV2Sha256(row.requestBody) !== row.requestSha256 ||
      promotionV2Sha256(row.receiptBody) !== selection.terminalReceiptSha256) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_PREDECESSOR_CONFLICT");
    }
    let immutableProof;
    let receipt;
    try {
      immutableProof = providerReleaseImmutableProofV1Schema.parse(
        JSON.parse(row.immutableProofBody),
      );
      receipt = providerReleaseReceiptSchema.parse(JSON.parse(row.receiptBody));
    } catch {
      throw new PromotionV2PersistenceError("PROMOTION_V2_ACTIVE_STATE_UNPROVEN");
    }
    if (canonicalJson(immutableProof) !== row.immutableProofBody ||
      canonicalJson(immutableProof) !== canonicalJson(reference) ||
      canonicalJson(receipt) !== row.receiptBody ||
      receipt.operationId !== selection.terminalOperationId ||
      receipt.operationKind !== selection.terminalOperationKind ||
      receipt.requestDigest !== row.requestSha256 ||
      receipt.platformKey !== selection.platformKey ||
      receipt.publicProviderReleaseId !== selection.publicProviderReleaseId ||
      !("details" in receipt) || !("release" in receipt.details) ||
      canonicalJson(receipt.details.release) !== canonicalJson(immutableProof) ||
      canonicalJson(receipt.details.providerCheckpoint) !==
        canonicalJson(selection.selectedProviderCheckpoint)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_PREDECESSOR_CONFLICT");
    }
    resolved.push({
      selection,
      fingerprint: row.fingerprint,
      artifactAttemptId: row.artifactAttemptId,
      activatedAt: input.activationOccurred
        ? input.reconciledAt
        : previousSelections.get(selection.platformKey)?.activatedAt ??
          input.reconciledAt,
    });
  }

  await transaction.$executeRaw(Prisma.sql`
    delete from public.manifest_active_provider_selections
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
  `);
  for (const item of resolved) {
    const body = canonicalJson(item.selection);
    await transaction.$executeRaw(Prisma.sql`
      insert into public.manifest_active_provider_selections (
        organization_id, deployment_key, platform_key, active_generation,
        manifest_public_release_id, provider_public_release_id,
        provider_release_fingerprint, selected_checkpoint,
        selection_body, selection_sha256, provider_terminal_operation_id,
        provider_terminal_receipt_sha256, publish_artifact_attempt_id,
        activated_at
      ) values (
        ${uuid(binding.organizationId)}, ${binding.deploymentKey},
        ${item.selection.platformKey}, ${BigInt(parsed.generation)},
        ${uuid(active!.publicReleaseId)},
        ${uuid(item.selection.publicProviderReleaseId)}, ${item.fingerprint},
        ${BigInt(item.selection.selectedProviderCheckpoint.settledSequence)},
        ${body}, ${promotionV2Sha256(body)},
        ${item.selection.terminalOperationId},
        ${item.selection.terminalReceiptSha256},
        ${uuid(item.artifactAttemptId)}, ${item.activatedAt}
      )
    `);
  }
  await transaction.$executeRaw(Prisma.sql`
    update public.manifest_promotion_lanes
    set bootstrap_state = ${active === null ? "verified_cleared" : "verified_active"},
        active_generation = ${BigInt(parsed.generation)},
        active_state_body = ${input.canonicalStateBody},
        active_state_sha256 = ${promotionV2Sha256(input.canonicalStateBody)},
        active_state_receipt_body = ${input.stateReceiptBody},
        active_state_receipt_sha256 = ${input.stateReceiptSha256},
        active_state_response_body = ${input.exactResponseBody},
        active_state_response_sha256 = ${input.responseSha256},
        active_public_release_id = ${
          active === null ? Prisma.sql`null` : uuid(active.publicReleaseId)
        }, active_manifest_fingerprint = ${active?.manifestFingerprint ?? null},
        active_provider_reference_set_hash = ${
          active?.providerReferenceSetHash ?? null
        }, active_configuration_epoch_sequence = ${
          active === null
            ? Prisma.sql`null`
            : BigInt(active.sharedConfigurationEpoch.publicChangeSequence)
        }, active_terminal_receipt_sha256 = ${parsed.terminalReceiptSha256},
        delayed_provider_count = ${parsed.observation?.delayedProviderCount ?? 0},
        last_activated_at = case when ${input.activationOccurred && active !== null}
          then ${input.reconciledAt} else last_activated_at end,
        last_reconciled_at = ${input.reconciledAt},
        updated_at = ${input.reconciledAt}
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
  `);
}
