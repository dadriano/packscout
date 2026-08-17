import {
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActiveStateRequestSchema,
  catalogManifestSignedReceiptEnvelopeSchema,
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseCompletedHeadRequestSchema,
  providerReleaseCompletedHeadStateV1Schema,
  providerReleaseReceiptSchema,
  providerReleaseSignedReceiptEnvelopeSchema,
  type ProviderReleaseCompletedHeadStateV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";
import type {
  CatalogPromotionBootstrapProof,
  PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";
import {
  PromotionV2PersistenceError,
  promotionV2Sha256,
} from "./promotion-v2-types.ts";
import type {
  CatalogPromotionBootstrapProofRow,
  CatalogPromotionBootstrapProviderProofRow,
} from "./catalog-promotion-bootstrap-proof-rows.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function corrupt(): never {
  throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
}

function exactBody(body: string, sha256: string): void {
  if (promotionV2Sha256(body) !== sha256) corrupt();
}

function exactOptionalBody(
  body: string | null,
  sha256: string | null,
): void {
  if ((body === null) !== (sha256 === null)) corrupt();
  if (body !== null) exactBody(body, sha256!);
}

function parseCanonical<T>(
  body: string,
  schema: { safeParse(value: unknown):
    { success: true; data: T } | { success: false } },
): T {
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    if (!parsed.success || canonicalJson(parsed.data) !== body) corrupt();
    return parsed.data;
  } catch (error) {
    if (error instanceof PromotionV2PersistenceError) throw error;
    return corrupt();
  }
}

function validateExactResponse(
  body: string | null,
  sha256: string | null,
  receiptBody: string,
  kind: "manifest" | "provider",
): void {
  exactOptionalBody(body, sha256);
  if (body === null) return;
  try {
    const parsed = kind === "manifest"
      ? catalogManifestSignedReceiptEnvelopeSchema.safeParse(JSON.parse(body))
      : providerReleaseSignedReceiptEnvelopeSchema.safeParse(JSON.parse(body));
    if (!parsed.success || canonicalJson(parsed.data.receipt) !== receiptBody) {
      corrupt();
    }
  } catch (error) {
    if (error instanceof PromotionV2PersistenceError) throw error;
    corrupt();
  }
}

export async function loadCatalogPromotionBootstrapProof(
  database: PackscoutQueryClient,
  binding: PromotionV2ScopeBinding,
): Promise<CatalogPromotionBootstrapProof | null> {
  const rows = await database.$queryRaw<CatalogPromotionBootstrapProofRow[]>(
    Prisma.sql`
      select proof.proof_revision as "proofRevision",
             proof.proof_kind as "proofKind",
             lane.bootstrap_provider_set_body as "providerSetBody",
             lane.bootstrap_provider_set_sha256 as "providerSetSha256",
             proof.active_state_request_body as "activeStateRequestBody",
             proof.active_state_request_sha256 as "activeStateRequestSha256",
             proof.active_state_receipt_body as "activeStateReceiptBody",
             proof.active_state_receipt_sha256 as "activeStateReceiptSha256",
             proof.active_state_response_body as "activeStateResponseBody",
             proof.active_state_response_sha256 as "activeStateResponseSha256",
             proof.manifest_definition_request_body as "manifestDefinitionRequestBody",
             proof.manifest_definition_request_sha256
               as "manifestDefinitionRequestSha256",
             proof.manifest_terminal_request_body as "manifestTerminalRequestBody",
             proof.manifest_terminal_request_sha256
               as "manifestTerminalRequestSha256",
             proof.manifest_receipt_body as "manifestReceiptBody",
             proof.manifest_receipt_sha256 as "manifestReceiptSha256",
             proof.manifest_response_body as "manifestResponseBody",
             proof.manifest_response_sha256 as "manifestResponseSha256",
             proof.active_state_body as "activeStateBody",
             proof.active_state_sha256 as "activeStateSha256",
             proof.verified_at as "verifiedAt"
      from public.manifest_promotion_lanes as lane
      join public.catalog_promotion_bootstrap_proofs as proof
        on proof.organization_id = lane.organization_id
       and proof.deployment_key = lane.deployment_key
       and proof.proof_revision = lane.current_bootstrap_proof_revision
      where lane.organization_id = ${uuid(binding.organizationId)}
        and lane.deployment_key = ${binding.deploymentKey}
    `,
  );
  const row = rows[0];
  if (!row) return null;
  if (rows.length !== 1) corrupt();
  exactBody(row.providerSetBody, row.providerSetSha256);
  exactBody(row.activeStateRequestBody, row.activeStateRequestSha256);
  exactBody(row.activeStateReceiptBody, row.activeStateReceiptSha256);
  exactBody(row.activeStateBody, row.activeStateSha256);
  exactOptionalBody(
    row.manifestDefinitionRequestBody,
    row.manifestDefinitionRequestSha256,
  );
  exactOptionalBody(
    row.manifestTerminalRequestBody,
    row.manifestTerminalRequestSha256,
  );
  exactOptionalBody(row.manifestReceiptBody, row.manifestReceiptSha256);
  validateExactResponse(
    row.activeStateResponseBody,
    row.activeStateResponseSha256,
    row.activeStateReceiptBody,
    "manifest",
  );
  if (row.manifestReceiptBody !== null) {
    validateExactResponse(
      row.manifestResponseBody,
      row.manifestResponseSha256,
      row.manifestReceiptBody,
      "manifest",
    );
  } else {
    exactOptionalBody(row.manifestResponseBody, row.manifestResponseSha256);
  }
  const activeState = parseCanonical(
    row.activeStateBody,
    activeCatalogManifestStateV1Schema,
  );
  const activeRequest = parseCanonical(
    row.activeStateRequestBody,
    catalogManifestActiveStateRequestSchema,
  );
  const activeReceipt = parseCanonical(
    row.activeStateReceiptBody,
    catalogManifestActiveStateReceiptSchema,
  );
  if (activeReceipt.operationId !== activeRequest.operationId ||
    activeReceipt.requestDigest !== row.activeStateRequestSha256 ||
    canonicalJson(activeReceipt.details.activeState) !== row.activeStateBody) {
    corrupt();
  }
  let providerSet: unknown;
  try {
    providerSet = JSON.parse(row.providerSetBody);
  } catch {
    return corrupt();
  }
  if (!Array.isArray(providerSet) || providerSet.some((key) =>
    typeof key !== "string")) corrupt();
  const providers = await database.$queryRaw<
    CatalogPromotionBootstrapProviderProofRow[]
  >(Prisma.sql`
    select ordinal, platform_key as "platformKey",
           public_provider_release_id::text as "publicProviderReleaseId",
           provider_release_fingerprint as "providerReleaseFingerprint",
           provider_terminal_operation_id as "providerTerminalOperationId",
           provider_terminal_receipt_body as "providerTerminalReceiptBody",
           provider_terminal_receipt_sha256 as "providerTerminalReceiptSha256",
           provider_terminal_response_body as "providerTerminalResponseBody",
           provider_terminal_response_sha256
             as "providerTerminalResponseSha256",
           publish_artifact_attempt_id::text as "publishArtifactAttemptId",
           completed_head_request_body as "completedHeadRequestBody",
           completed_head_request_sha256 as "completedHeadRequestSha256",
           completed_head_receipt_body as "completedHeadReceiptBody",
           completed_head_receipt_sha256 as "completedHeadReceiptSha256",
           completed_head_response_body as "completedHeadResponseBody",
           completed_head_response_sha256 as "completedHeadResponseSha256",
           remote_completed_head_body as "remoteCompletedHeadBody",
           remote_completed_head_sha256 as "remoteCompletedHeadSha256",
           local_completed_attempt_id::text as "localCompletedAttemptId",
           local_completed_public_provider_release_id::text
             as "localCompletedPublicProviderReleaseId",
           local_completed_provider_release_fingerprint
             as "localCompletedProviderReleaseFingerprint",
           local_completed_terminal_receipt_sha256
             as "localCompletedTerminalReceiptSha256"
    from public.catalog_promotion_bootstrap_provider_proofs
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
      and proof_revision = ${row.proofRevision}
    order by ordinal
  `);
  if (providers.length !== providerSet.length || providers.some(
    (provider, index) => provider.ordinal !== index ||
      provider.platformKey !== providerSet[index],
  )) corrupt();
  for (const provider of providers) {
    exactBody(
      provider.completedHeadRequestBody,
      provider.completedHeadRequestSha256,
    );
    exactBody(
      provider.completedHeadReceiptBody,
      provider.completedHeadReceiptSha256,
    );
    exactBody(
      provider.remoteCompletedHeadBody,
      provider.remoteCompletedHeadSha256,
    );
    validateExactResponse(
      provider.completedHeadResponseBody,
      provider.completedHeadResponseSha256,
      provider.completedHeadReceiptBody,
      "provider",
    );
    const request = parseCanonical(
      provider.completedHeadRequestBody,
      providerReleaseCompletedHeadRequestSchema,
    );
    const receipt = parseCanonical(
      provider.completedHeadReceiptBody,
      providerReleaseCompletedHeadReceiptSchema,
    );
    const remoteHead = parseCanonical(
      provider.remoteCompletedHeadBody,
      providerReleaseCompletedHeadStateV1Schema,
    );
    if (request.platformKey !== provider.platformKey ||
      receipt.platformKey !== provider.platformKey ||
      receipt.operationId !== request.operationId ||
      receipt.requestDigest !== provider.completedHeadRequestSha256 ||
      canonicalJson(receipt.details.head) !== canonicalJson(remoteHead)) {
      corrupt();
    }
    if (provider.publicProviderReleaseId === null) {
      if (provider.providerReleaseFingerprint !== null ||
        provider.providerTerminalOperationId !== null ||
        provider.providerTerminalReceiptBody !== null ||
        provider.providerTerminalReceiptSha256 !== null ||
        provider.providerTerminalResponseBody !== null ||
        provider.providerTerminalResponseSha256 !== null ||
        provider.publishArtifactAttemptId !== null) corrupt();
    } else {
      if (provider.providerReleaseFingerprint === null ||
        provider.providerTerminalOperationId === null ||
        provider.providerTerminalReceiptBody === null ||
        provider.providerTerminalReceiptSha256 === null ||
        provider.publishArtifactAttemptId === null) corrupt();
      exactBody(
        provider.providerTerminalReceiptBody!,
        provider.providerTerminalReceiptSha256!,
      );
      const terminal = parseCanonical(
        provider.providerTerminalReceiptBody!,
        providerReleaseReceiptSchema,
      );
      if (terminal.operationId !== provider.providerTerminalOperationId ||
        terminal.publicProviderReleaseId !== provider.publicProviderReleaseId) {
        corrupt();
      }
      validateExactResponse(
        provider.providerTerminalResponseBody,
        provider.providerTerminalResponseSha256,
        provider.providerTerminalReceiptBody!,
        "provider",
      );
    }
  }
  return {
    proofRevision: row.proofRevision,
    proofKind: row.proofKind,
    activeStateRequestBody: row.activeStateRequestBody,
    activeStateReceiptBody: row.activeStateReceiptBody,
    activeStateResponseBody: row.activeStateResponseBody,
    activeState,
    manifestDefinitionRequestBody: row.manifestDefinitionRequestBody,
    manifestTerminalRequestBody: row.manifestTerminalRequestBody,
    manifestReceiptBody: row.manifestReceiptBody,
    manifestResponseBody: row.manifestResponseBody,
    providers: providers.map((provider) => ({
      platformKey: provider.platformKey,
      activeReference: provider.publicProviderReleaseId === null ? null : {
        publicProviderReleaseId: provider.publicProviderReleaseId,
        providerReleaseFingerprint: provider.providerReleaseFingerprint!,
        providerTerminalOperationId: provider.providerTerminalOperationId!,
        providerTerminalReceiptBody: provider.providerTerminalReceiptBody!,
        providerTerminalReceiptSha256:
          provider.providerTerminalReceiptSha256!,
        providerTerminalResponseBody: provider.providerTerminalResponseBody,
        publishArtifactAttemptId: provider.publishArtifactAttemptId!,
      },
      completedHeadProbe: {
        requestBody: provider.completedHeadRequestBody,
        receiptBody: provider.completedHeadReceiptBody,
        exactResponseBody: provider.completedHeadResponseBody,
        remoteHead: JSON.parse(provider.remoteCompletedHeadBody) as
          ProviderReleaseCompletedHeadStateV1,
      },
      localCompletedHead: provider.localCompletedAttemptId === null ? null : {
        attemptId: provider.localCompletedAttemptId,
        publicProviderReleaseId: provider.localCompletedPublicProviderReleaseId!,
        providerReleaseFingerprint:
          provider.localCompletedProviderReleaseFingerprint!,
        terminalReceiptSha256: provider.localCompletedTerminalReceiptSha256!,
      },
    })),
    verifiedAt: row.verifiedAt,
  };
}
