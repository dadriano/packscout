import {
  canonicalJson,
  type ActiveCatalogManifestStateV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import {
  PromotionV2PersistenceError,
  promotionV2Sha256,
  type CatalogPromotionBootstrapProviderProof,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function applyInitialCatalogPromotionBootstrapState(
  transaction: PackscoutTransactionClient,
  binding: PromotionV2ScopeBinding,
  input: Readonly<{
    proofKind: "empty" | "cleared" | "active";
    activeStateReceiptBody: string;
    providers: readonly CatalogPromotionBootstrapProviderProof[];
    verifiedAt: Date;
    state: ActiveCatalogManifestStateV1;
    stateBody: string;
    receiptSha256: string;
    response: Readonly<{ body: string | null; sha256: string | null }>;
    activatedAt: Date | null;
    proofRevision: bigint;
  }>,
): Promise<void> {
  const providerSetBody = canonicalJson(
    input.providers.map(({ platformKey }) => platformKey),
  );
  if (input.proofKind === "empty") {
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set bootstrap_state = 'verified_empty',
          bootstrap_verified_at = ${input.verifiedAt},
          bootstrap_provider_set_body = ${providerSetBody},
          bootstrap_provider_set_sha256 = ${promotionV2Sha256(providerSetBody)},
          current_bootstrap_proof_revision = ${input.proofRevision},
          active_generation = 0,
          active_state_body = ${input.stateBody},
          active_state_sha256 = ${promotionV2Sha256(input.stateBody)},
          active_state_receipt_body = ${input.activeStateReceiptBody},
          active_state_receipt_sha256 = ${input.receiptSha256},
          active_state_response_body = ${input.response.body},
          active_state_response_sha256 = ${input.response.sha256},
          last_reconciled_at = ${input.verifiedAt},
          updated_at = ${input.verifiedAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
    `);
    return;
  }
  if (input.proofKind === "cleared") {
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set bootstrap_state = 'verified_cleared',
          bootstrap_verified_at = ${input.verifiedAt},
          bootstrap_provider_set_body = ${providerSetBody},
          bootstrap_provider_set_sha256 = ${promotionV2Sha256(providerSetBody)},
          current_bootstrap_proof_revision = ${input.proofRevision},
          active_generation = ${BigInt(input.state.generation)},
          active_state_body = ${input.stateBody},
          active_state_sha256 = ${promotionV2Sha256(input.stateBody)},
          active_state_receipt_body = ${input.activeStateReceiptBody},
          active_state_receipt_sha256 = ${input.receiptSha256},
          active_state_response_body = ${input.response.body},
          active_state_response_sha256 = ${input.response.sha256},
          active_public_release_id = null,
          active_manifest_fingerprint = null,
          active_provider_reference_set_hash = null,
          active_configuration_epoch_sequence = null,
          active_terminal_receipt_sha256 = ${input.state.terminalReceiptSha256},
          delayed_provider_count = 0, last_activated_at = null,
          last_reconciled_at = ${input.verifiedAt}, updated_at = ${input.verifiedAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
    `);
    return;
  }
  if (input.activatedAt === null) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
  }
  const active = input.state.activeManifest!;
  await transaction.$executeRaw(Prisma.sql`
    update public.manifest_promotion_lanes
    set bootstrap_state = 'verified_active',
        bootstrap_verified_at = ${input.verifiedAt},
        bootstrap_provider_set_body = ${providerSetBody},
        bootstrap_provider_set_sha256 = ${promotionV2Sha256(providerSetBody)},
        current_bootstrap_proof_revision = ${input.proofRevision},
        active_generation = ${BigInt(input.state.generation)},
        active_state_body = ${input.stateBody},
        active_state_sha256 = ${promotionV2Sha256(input.stateBody)},
        active_state_receipt_body = ${input.activeStateReceiptBody},
        active_state_receipt_sha256 = ${input.receiptSha256},
        active_state_response_body = ${input.response.body},
        active_state_response_sha256 = ${input.response.sha256},
        active_public_release_id = ${uuid(active.publicReleaseId)},
        active_manifest_fingerprint = ${active.manifestFingerprint},
        active_provider_reference_set_hash = ${active.providerReferenceSetHash},
        active_configuration_epoch_sequence = ${BigInt(
          active.sharedConfigurationEpoch.publicChangeSequence,
        )}, active_terminal_receipt_sha256 = ${input.state.terminalReceiptSha256},
        delayed_provider_count = ${input.state.observation!.delayedProviderCount},
        last_activated_at = ${input.activatedAt},
        last_reconciled_at = ${input.verifiedAt}, updated_at = ${input.verifiedAt}
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
  `);
  for (const selection of input.state.observation!.providerSelections) {
    const proof = input.providers.find(
      ({ platformKey }) => platformKey === selection.platformKey,
    );
    const activeProof = proof?.activeReference;
    if (!activeProof) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    const selectionBody = canonicalJson(selection);
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
        ${selection.platformKey}, ${BigInt(input.state.generation)},
        ${uuid(active.publicReleaseId)}, ${uuid(selection.publicProviderReleaseId)},
        ${activeProof.providerReleaseFingerprint},
        ${BigInt(selection.selectedProviderCheckpoint.settledSequence)},
        ${selectionBody}, ${promotionV2Sha256(selectionBody)},
        ${selection.terminalOperationId}, ${selection.terminalReceiptSha256},
        ${uuid(activeProof.publishArtifactAttemptId)}, ${input.activatedAt}
      )
    `);
  }
}
