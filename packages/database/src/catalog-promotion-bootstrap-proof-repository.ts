import {
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActiveStateRequestSchema,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRollbackRequestSchema,
  catalogManifestReceiptSchema,
  catalogManifestSignedReceiptEnvelopeSchema,
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseCompletedHeadResultV1Schema,
  providerReleaseCompletedHeadRequestSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseReceiptSchema,
  providerReleaseSignedReceiptEnvelopeSchema,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestMutationRequest,
  type ProviderReleaseCompletedHeadStateV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { loadManifestEligibilitySnapshotInTransaction } from
  "./public-change-settlement-repository.provider-read.ts";
import {
  PromotionV2PersistenceError,
  assertPromotionV2Binding,
  finiteDate,
  promotionV2Sha256,
  type CatalogPromotionBootstrapProof,
  type CatalogPromotionBootstrapLocalCandidate,
  type CatalogPromotionBootstrapProviderProof,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";
import { selectManifestDefinitionRequestBody } from
  "./catalog-promotion-bootstrap-candidate.ts";
import {
  loadCatalogPromotionBootstrapState,
  type CatalogPromotionBootstrapState,
} from "./catalog-promotion-bootstrap-state.ts";
import { loadCatalogPromotionBootstrapProof } from
  "./catalog-promotion-bootstrap-proof-read.ts";
import { lockPromotionConfigurationScope } from
  "./promotion-v2-bootstrap-proof-guard.ts";
import { applyInitialCatalogPromotionBootstrapState } from
  "./catalog-promotion-bootstrap-initial-state.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function parseExact<T>(
  body: string,
  schema: { safeParse(value: unknown):
    { success: true; data: T } | { success: false } },
): T {
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    if (!parsed.success || canonicalJson(parsed.data) !== body) throw new Error();
    return parsed.data;
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
  }
}

function validateExactResponse(
  exactResponseBody: string | null | undefined,
  receiptBody: string,
  kind: "provider" | "manifest",
): Readonly<{ body: string | null; sha256: string | null }> {
  if (exactResponseBody === null || exactResponseBody === undefined) {
    return { body: null, sha256: null };
  }
  try {
    const json = JSON.parse(exactResponseBody) as unknown;
    const parsed = kind === "provider"
      ? providerReleaseSignedReceiptEnvelopeSchema.safeParse(json)
      : catalogManifestSignedReceiptEnvelopeSchema.safeParse(json);
    if (!parsed.success || canonicalJson(parsed.data.receipt) !== receiptBody) {
      throw new Error();
    }
    return { body: exactResponseBody, sha256: promotionV2Sha256(exactResponseBody) };
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
  }
}

function validateProviderProbe(
  proof: CatalogPromotionBootstrapProviderProof,
): Readonly<{
  remoteHead: ProviderReleaseCompletedHeadStateV1;
  requestSha256: string;
  receiptSha256: string;
  responseBody: string | null;
  responseSha256: string | null;
}> {
  const request = parseExact(
    proof.completedHeadProbe.requestBody,
    providerReleaseCompletedHeadRequestSchema,
  );
  const receipt = parseExact(
    proof.completedHeadProbe.receiptBody,
    providerReleaseCompletedHeadReceiptSchema,
  );
  const requestSha256 = promotionV2Sha256(
    proof.completedHeadProbe.requestBody,
  );
  if (
    request.platformKey !== proof.platformKey ||
    receipt.platformKey !== proof.platformKey ||
    receipt.operationId !== request.operationId ||
    receipt.requestDigest !== requestSha256 ||
    canonicalJson(receipt.details.head) !==
      canonicalJson(proof.completedHeadProbe.remoteHead)
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
  const response = validateExactResponse(
    proof.completedHeadProbe.exactResponseBody,
    proof.completedHeadProbe.receiptBody,
    "provider",
  );
  return {
    remoteHead: receipt.details.head,
    requestSha256,
    receiptSha256: promotionV2Sha256(proof.completedHeadProbe.receiptBody),
    responseBody: response.body,
    responseSha256: response.sha256,
  };
}

function parseProviderTerminalRequest(
  body: string,
  kind: "finalize" | "confirmReuse",
) {
  return kind === "finalize"
    ? parseExact(body, providerReleaseFinalizeRequestSchema)
    : parseExact(body, providerReleaseConfirmReuseRequestSchema);
}

function activeStateCore(state: ActiveCatalogManifestStateV1): Readonly<{
  generation: number;
  activeManifest: ActiveCatalogManifestStateV1["activeManifest"];
  previousManifest: ActiveCatalogManifestStateV1["previousManifest"];
  observation: ActiveCatalogManifestStateV1["observation"];
}> {
  return {
    generation: state.generation,
    activeManifest: state.activeManifest,
    previousManifest: state.previousManifest,
    observation: state.observation,
  };
}

function validateManifestTerminalProof(input: Readonly<{
  proofKind: "cleared" | "active";
  activeState: ActiveCatalogManifestStateV1;
  manifestDefinitionRequestBody: string | null;
  manifestTerminalRequestBody: string | null;
  manifestReceiptBody: string | null;
  manifestExactResponseBody?: string | null;
}>): Readonly<{
  definitionRequestSha256: string | null;
  terminalRequestSha256: string;
  receiptSha256: string;
  responseBody: string | null;
  responseSha256: string | null;
}> {
  if (input.manifestTerminalRequestBody === null ||
    input.manifestReceiptBody === null || input.activeState.generation <= 0 ||
    input.activeState.terminalReceiptSha256 === null) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
  }
  const receipt = parseExact(
    input.manifestReceiptBody,
    catalogManifestReceiptSchema,
  );
  if (receipt.operationKind === "activeState" ||
    receipt.operationKind === "block") {
    throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
  }
  let request: CatalogManifestMutationRequest;
  switch (receipt.operationKind) {
    case "activateManifest":
      request = parseExact(
        input.manifestTerminalRequestBody,
        catalogManifestActivateRequestSchema,
      );
      break;
    case "refreshActiveState":
      request = parseExact(
        input.manifestTerminalRequestBody,
        catalogManifestRefreshActiveStateRequestSchema,
      );
      break;
    case "rollback":
      request = parseExact(
        input.manifestTerminalRequestBody,
        catalogManifestRollbackRequestSchema,
      );
      break;
  }
  const terminalRequestSha256 = promotionV2Sha256(
    input.manifestTerminalRequestBody,
  );
  const receiptSha256 = promotionV2Sha256(input.manifestReceiptBody);
  if (
    receipt.operationId !== request.operationId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.requestDigest !== terminalRequestSha256 ||
    receiptSha256 !== input.activeState.terminalReceiptSha256 ||
    canonicalJson(receipt.details.expectedActiveState) !==
      canonicalJson(request.expectedActiveState) ||
    canonicalJson(receipt.details.activeState) !==
      canonicalJson(activeStateCore(input.activeState))
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");

  let definitionRequestSha256: string | null = null;
  if (input.proofKind === "cleared") {
    if (input.manifestDefinitionRequestBody !== null ||
      receipt.operationKind !== "rollback" ||
      !("rollbackKind" in request) || request.rollbackKind !== "clear" ||
      receipt.rollbackKind !== "clear" ||
      input.activeState.activeManifest !== null ||
      input.activeState.previousManifest !== null ||
      input.activeState.observation !== null) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
  } else {
    if (input.manifestDefinitionRequestBody === null ||
      input.activeState.activeManifest === null ||
      input.activeState.observation === null ||
      receipt.publicReleaseId !==
        input.activeState.activeManifest.publicReleaseId ||
      receipt.manifestFingerprint !==
        input.activeState.activeManifest.manifestFingerprint) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    const definition = parseExact(
      input.manifestDefinitionRequestBody,
      catalogManifestActivateRequestSchema,
    );
    definitionRequestSha256 = promotionV2Sha256(
      input.manifestDefinitionRequestBody,
    );
    if (canonicalJson({
      publicReleaseId: definition.manifest.publicReleaseId,
      manifestFingerprint: definition.manifest.manifestFingerprint,
      sharedConfigurationEpoch: definition.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: definition.manifest.providerReferenceSetHash,
    }) !== canonicalJson(input.activeState.activeManifest)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    const selectedIdentity = "rollbackKind" in request
      ? request.rollbackKind === "manifest" ? request.targetManifest : null
      : request.manifest;
    const selectedObservation = "rollbackKind" in request
      ? request.rollbackKind === "manifest" ? request.observation : null
      : request.observation;
    if (selectedIdentity === null || selectedObservation === null ||
      canonicalJson(selectedIdentity) !==
        canonicalJson(input.activeState.activeManifest) ||
      canonicalJson(selectedObservation) !==
        canonicalJson(input.activeState.observation)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
  }
  const response = validateExactResponse(
    input.manifestExactResponseBody,
    input.manifestReceiptBody,
    "manifest",
  );
  return {
    definitionRequestSha256,
    terminalRequestSha256,
    receiptSha256,
    responseBody: response.body,
    responseSha256: response.sha256,
  };
}

/** Exact, one-time bootstrap anchor plus restart validation against current rows. */
export class PrismaCatalogPromotionBootstrapProofRepository {
  readonly #organizationId: string;
  readonly #deploymentKey: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    binding: PromotionV2ScopeBinding,
  ) {
    assertPromotionV2Binding(binding);
    this.#organizationId = binding.organizationId.toLowerCase();
    this.#deploymentKey = binding.deploymentKey;
  }

  async loadState(): Promise<CatalogPromotionBootstrapState> {
    return loadCatalogPromotionBootstrapState(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    });
  }

  async loadLocalCandidate(input: Readonly<{
    activeState: ActiveCatalogManifestStateV1;
  }>): Promise<CatalogPromotionBootstrapLocalCandidate | null> {
    const state = activeCatalogManifestStateV1Schema.parse(input.activeState);
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      const eligibility = await loadManifestEligibilitySnapshotInTransaction(
        transaction,
        { organizationId: this.#organizationId },
      );
      if (!eligibility) return null;
      let manifestDefinitionRequestBody: string | null = null;
      let manifestTerminalRequestBody: string | null = null;
      let manifestReceiptBody: string | null = null;
      let manifestExactResponseBody: string | null = null;
      if (state.generation > 0) {
        if (state.terminalReceiptSha256 === null) return null;
        const terminalRows = await transaction.$queryRaw<Array<{
          requestBody: string;
          requestSha256: string;
          receiptBody: string;
          receiptSha256: string;
          exactResponseBody: string | null;
          responseSha256: string | null;
        }>>(Prisma.sql`
          select canonical_request_body as "requestBody",
                 request_sha256 as "requestSha256",
                 canonical_receipt_body as "receiptBody",
                 receipt_sha256 as "receiptSha256",
                 exact_response_body as "exactResponseBody",
                 response_sha256 as "responseSha256"
          from public.manifest_promotion_operations
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and state = 'acknowledged'
            and receipt_sha256 = ${state.terminalReceiptSha256}
        `);
        const terminal = terminalRows[0];
        if (!terminal || terminalRows.length !== 1 ||
          promotionV2Sha256(terminal.requestBody) !== terminal.requestSha256 ||
          promotionV2Sha256(terminal.receiptBody) !== terminal.receiptSha256 ||
          (terminal.exactResponseBody === null) !==
            (terminal.responseSha256 === null) ||
          (terminal.exactResponseBody !== null &&
            promotionV2Sha256(terminal.exactResponseBody) !==
              terminal.responseSha256)) return null;
        manifestTerminalRequestBody = terminal.requestBody;
        manifestReceiptBody = terminal.receiptBody;
        manifestExactResponseBody = terminal.exactResponseBody;
      }
      if (state.activeManifest !== null) {
        const definitionRows = await transaction.$queryRaw<Array<{
          requestBody: string;
        }>>(Prisma.sql`
          select operation.canonical_request_body as "requestBody"
          from public.manifest_promotion_operations as operation
          join public.manifest_promotion_attempts as attempt
            on attempt.id = operation.attempt_id
           and attempt.organization_id = operation.organization_id
           and attempt.deployment_key = operation.deployment_key
          where operation.organization_id = ${uuid(this.#organizationId)}
            and operation.deployment_key = ${this.#deploymentKey}
            and operation.operation_kind = 'activateManifest'
            and operation.state = 'acknowledged'
            and attempt.public_release_id = ${uuid(
              state.activeManifest.publicReleaseId,
            )}
          order by operation.acknowledged_at desc,
                   operation.operation_id collate "C" desc
        `);
        manifestDefinitionRequestBody = selectManifestDefinitionRequestBody({
          activeManifest: state.activeManifest,
          terminalRequestBody: manifestTerminalRequestBody,
          definitionRequestBodies: definitionRows.map(({ requestBody }) =>
            requestBody),
        });
        if (manifestDefinitionRequestBody === null) return null;
      }
      const completedRows = await transaction.$queryRaw<Array<{
        platformKey: string;
        completedCheckpoint: bigint;
        attemptId: string | null;
        publicProviderReleaseId: string | null;
        providerReleaseFingerprint: string | null;
        terminalReceiptSha256: string | null;
      }>>(Prisma.sql`
        select configured.platform_key as "platformKey",
               coalesce(lane.completed_checkpoint, 0) as "completedCheckpoint",
               lane.completed_attempt_id::text as "attemptId",
               lane.completed_public_provider_release_id::text
                 as "publicProviderReleaseId",
               lane.completed_provider_release_fingerprint
                 as "providerReleaseFingerprint",
               lane.completed_terminal_receipt_sha256
                 as "terminalReceiptSha256"
        from unnest(${[...eligibility.configuredPlatformKeys]}::text[])
          with ordinality as configured(platform_key, ordinal)
        left join public.provider_promotion_lanes as lane
          on lane.organization_id = ${uuid(this.#organizationId)}
         and lane.deployment_key = ${this.#deploymentKey}
         and lane.platform_key = configured.platform_key
        order by configured.platform_key collate "C"
      `);
      const observed = new Map(
        (state.observation?.providerSelections ?? []).map((selection) => [
          selection.platformKey, selection,
        ]),
      );
      const providers = [] as Array<
        CatalogPromotionBootstrapLocalCandidate["providers"][number]
      >;
      for (const completed of completedRows) {
        const selection = observed.get(completed.platformKey) ?? null;
        let activeReference = null;
        if (selection !== null) {
          const rows = await transaction.$queryRaw<Array<{
            publicProviderReleaseId: string;
            providerReleaseFingerprint: string;
            providerTerminalOperationId: string;
            providerTerminalReceiptBody: string;
            providerTerminalReceiptSha256: string;
            providerTerminalResponseBody: string | null;
            providerTerminalResponseSha256: string | null;
            publishArtifactAttemptId: string;
            requestBody: string;
            requestSha256: string;
            attemptState: string;
          }>>(Prisma.sql`
            select artifact.public_provider_release_id::text
                     as "publicProviderReleaseId",
                   artifact.provider_release_fingerprint
                     as "providerReleaseFingerprint",
                   operation.operation_id as "providerTerminalOperationId",
                   operation.canonical_receipt_body
                     as "providerTerminalReceiptBody",
                   operation.receipt_sha256 as "providerTerminalReceiptSha256",
                   operation.exact_response_body
                     as "providerTerminalResponseBody",
                   operation.response_sha256
                     as "providerTerminalResponseSha256",
                   artifact.publish_attempt_id::text
                     as "publishArtifactAttemptId",
                   operation.canonical_request_body as "requestBody",
                   operation.request_sha256 as "requestSha256",
                   attempt.state as "attemptState"
            from public.provider_release_artifacts as artifact
            join public.provider_promotion_operations as operation
              on operation.organization_id = artifact.organization_id
             and operation.deployment_key = artifact.deployment_key
             and operation.platform_key = artifact.platform_key
             and operation.operation_id = ${selection.terminalOperationId}
             and operation.operation_kind = ${selection.terminalOperationKind}
             and operation.state = 'acknowledged'
             and operation.receipt_sha256 = ${selection.terminalReceiptSha256}
            join public.provider_promotion_attempts as attempt
              on attempt.id = operation.attempt_id
             and attempt.organization_id = operation.organization_id
             and attempt.deployment_key = operation.deployment_key
             and attempt.platform_key = operation.platform_key
            where artifact.organization_id = ${uuid(this.#organizationId)}
              and artifact.deployment_key = ${this.#deploymentKey}
              and artifact.platform_key = ${completed.platformKey}
              and artifact.public_provider_release_id = ${uuid(
                selection.publicProviderReleaseId,
              )}
          `);
          const row = rows[0];
          if (!row || rows.length !== 1 ||
            promotionV2Sha256(row.providerTerminalReceiptBody) !==
              row.providerTerminalReceiptSha256 ||
            (row.providerTerminalResponseBody === null) !==
              (row.providerTerminalResponseSha256 === null) ||
            (row.providerTerminalResponseBody !== null &&
              promotionV2Sha256(row.providerTerminalResponseBody) !==
                row.providerTerminalResponseSha256) ||
            promotionV2Sha256(row.requestBody) !== row.requestSha256 ||
            row.attemptState !== (selection.terminalOperationKind === "finalize"
              ? "published" : "reused")) return null;
          const receipt = parseExact(
            row.providerTerminalReceiptBody,
            providerReleaseReceiptSchema,
          );
          const request = parseProviderTerminalRequest(
            row.requestBody,
            selection.terminalOperationKind,
          );
          if (receipt.operationKind !== selection.terminalOperationKind ||
            receipt.operationId !== request.operationId ||
            receipt.idempotencyKey !== request.idempotencyKey ||
            receipt.requestDigest !== row.requestSha256 ||
            request.release.platformKey !== completed.platformKey ||
            request.release.publicProviderReleaseId !==
              selection.publicProviderReleaseId ||
            request.release.providerReleaseFingerprint !==
              row.providerReleaseFingerprint ||
            canonicalJson(request.release) !== canonicalJson(receipt.details.release) ||
            canonicalJson(request.providerCheckpoint) !==
              canonicalJson(selection.selectedProviderCheckpoint) ||
            canonicalJson(request.providerCheckpoint) !==
              canonicalJson(receipt.details.providerCheckpoint) ||
            canonicalJson(request.observation) !==
              canonicalJson(receipt.details.observation) ||
            request.sourceWatermark !== receipt.details.sourceWatermark ||
            canonicalJson(request.expectedCompletedHead) !==
              canonicalJson(receipt.details.expectedCompletedHead)) return null;
          activeReference = {
            publicProviderReleaseId: row.publicProviderReleaseId,
            providerReleaseFingerprint: row.providerReleaseFingerprint,
            providerTerminalOperationId: row.providerTerminalOperationId,
            providerTerminalReceiptBody: row.providerTerminalReceiptBody,
            providerTerminalReceiptSha256:
              row.providerTerminalReceiptSha256,
            providerTerminalResponseBody: row.providerTerminalResponseBody,
            publishArtifactAttemptId: row.publishArtifactAttemptId,
          };
        }
        const localCompletedHead = completed.completedCheckpoint === 0n
          ? null
          : completed.attemptId === null ||
            completed.publicProviderReleaseId === null ||
            completed.providerReleaseFingerprint === null ||
            completed.terminalReceiptSha256 === null
            ? null
            : {
                attemptId: completed.attemptId,
                publicProviderReleaseId: completed.publicProviderReleaseId,
                providerReleaseFingerprint:
                  completed.providerReleaseFingerprint,
                terminalReceiptSha256: completed.terminalReceiptSha256,
              };
        if (completed.completedCheckpoint > 0n && localCompletedHead === null) {
          return null;
        }
        providers.push({
          platformKey: completed.platformKey,
          activeReference,
          localCompletedHead,
        });
      }
      const proofKind = state.generation === 0
        ? "empty" : state.activeManifest === null ? "cleared" : "active";
      await this.#validateLocalManifestGraph(transaction, {
        proofKind,
        activeState: state,
        manifestDefinitionRequestBody,
        manifestTerminalRequestBody,
        manifestReceiptBody,
        manifestExactResponseBody,
      });
      return {
        manifestDefinitionRequestBody,
        manifestTerminalRequestBody,
        manifestReceiptBody,
        manifestExactResponseBody,
        providers,
      };
    }, {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async #validateLocalManifestGraph(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      proofKind: "empty" | "cleared" | "active";
      activeState: ActiveCatalogManifestStateV1;
      manifestDefinitionRequestBody: string | null;
      manifestTerminalRequestBody: string | null;
      manifestReceiptBody: string | null;
      manifestExactResponseBody?: string | null;
    }>,
  ): Promise<Date | null> {
    if (input.proofKind === "empty") {
      if (input.activeState.generation !== 0 ||
        input.manifestDefinitionRequestBody !== null ||
        input.manifestTerminalRequestBody !== null ||
        input.manifestReceiptBody !== null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      return null;
    }
    const validated = validateManifestTerminalProof({
      ...input,
      proofKind: input.proofKind === "cleared" ? "cleared" : "active",
    });
    const terminalRows = await transaction.$queryRaw<Array<{
      operationKind: string;
      requestBody: string;
      requestSha256: string;
      receiptBody: string;
      receiptSha256: string;
      exactResponseBody: string | null;
      responseSha256: string | null;
      attemptState: string;
    }>>(Prisma.sql`
      select operation.operation_kind as "operationKind",
             operation.canonical_request_body as "requestBody",
             operation.request_sha256 as "requestSha256",
             operation.canonical_receipt_body as "receiptBody",
             operation.receipt_sha256 as "receiptSha256",
             operation.exact_response_body as "exactResponseBody",
             operation.response_sha256 as "responseSha256",
             attempt.state as "attemptState"
      from public.manifest_promotion_operations as operation
      join public.manifest_promotion_attempts as attempt
        on attempt.id = operation.attempt_id
       and attempt.organization_id = operation.organization_id
       and attempt.deployment_key = operation.deployment_key
      where operation.organization_id = ${uuid(this.#organizationId)}
        and operation.deployment_key = ${this.#deploymentKey}
        and operation.state = 'acknowledged'
        and operation.receipt_sha256 = ${validated.receiptSha256}
    `);
    const terminal = terminalRows[0];
    const terminalReceipt = parseExact(
      input.manifestReceiptBody!,
      catalogManifestReceiptSchema,
    );
    if (!terminal || terminalRows.length !== 1 ||
      terminal.requestBody !== input.manifestTerminalRequestBody ||
      terminal.requestSha256 !== validated.terminalRequestSha256 ||
      terminal.receiptBody !== input.manifestReceiptBody ||
      terminal.receiptSha256 !== validated.receiptSha256 ||
      terminal.exactResponseBody !== (input.manifestExactResponseBody ?? null) ||
      (terminal.exactResponseBody === null) !==
        (terminal.responseSha256 === null) ||
      (terminal.exactResponseBody !== null &&
        promotionV2Sha256(terminal.exactResponseBody) !==
          terminal.responseSha256) ||
      terminal.operationKind !== terminalReceipt.operationKind ||
      terminal.attemptState !== terminalReceipt.result) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    if (input.proofKind === "cleared") return null;

    const definitionRows = await transaction.$queryRaw<Array<{
      requestBody: string;
      requestSha256: string;
      receiptBody: string;
      receiptSha256: string;
      attemptState: string;
    }>>(Prisma.sql`
      select operation.canonical_request_body as "requestBody",
             operation.request_sha256 as "requestSha256",
             operation.canonical_receipt_body as "receiptBody",
             operation.receipt_sha256 as "receiptSha256",
             attempt.state as "attemptState"
      from public.manifest_promotion_operations as operation
      join public.manifest_promotion_attempts as attempt
        on attempt.id = operation.attempt_id
       and attempt.organization_id = operation.organization_id
       and attempt.deployment_key = operation.deployment_key
      where operation.organization_id = ${uuid(this.#organizationId)}
        and operation.deployment_key = ${this.#deploymentKey}
        and operation.operation_kind = 'activateManifest'
        and operation.state = 'acknowledged'
        and operation.canonical_request_body = ${
          input.manifestDefinitionRequestBody
        }
    `);
    const definition = definitionRows[0];
    if (!definition || definitionRows.length !== 1 ||
      definition.requestSha256 !== validated.definitionRequestSha256 ||
      promotionV2Sha256(definition.requestBody) !== definition.requestSha256 ||
      promotionV2Sha256(definition.receiptBody) !== definition.receiptSha256 ||
      definition.attemptState !== "activated") {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    const definitionRequest = parseExact(
      definition.requestBody,
      catalogManifestActivateRequestSchema,
    );
    const definitionReceipt = parseExact(
      definition.receiptBody,
      catalogManifestReceiptSchema,
    );
    if (definitionReceipt.operationKind !== "activateManifest" ||
      definitionReceipt.operationId !== definitionRequest.operationId ||
      definitionReceipt.idempotencyKey !== definitionRequest.idempotencyKey ||
      definitionReceipt.requestDigest !== definition.requestSha256 ||
      canonicalJson(definitionReceipt.details.expectedActiveState) !==
        canonicalJson(definitionRequest.expectedActiveState) ||
      canonicalJson(definitionReceipt.details.activeState.observation) !==
        canonicalJson(definitionRequest.observation) ||
      definitionReceipt.publicReleaseId !==
        definitionRequest.manifest.publicReleaseId ||
      definitionReceipt.manifestFingerprint !==
        definitionRequest.manifest.manifestFingerprint) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    const activatedAt = new Date(definitionReceipt.serverTime);
    if (!finiteDate(activatedAt)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    return activatedAt;
  }

  async verifyEmpty(input: Readonly<{
    activeStateRequestBody: string;
    activeStateReceiptBody: string;
    activeStateExactResponseBody?: string | null;
    providers: readonly CatalogPromotionBootstrapProviderProof[];
    verifiedAt: Date;
  }>): Promise<void> {
    await this.#verify({
      proofKind: "empty",
      ...input,
      manifestDefinitionRequestBody: null,
      manifestTerminalRequestBody: null,
      manifestReceiptBody: null,
      manifestExactResponseBody: null,
    });
  }

  async verifyCleared(input: Readonly<{
    activeStateRequestBody: string;
    activeStateReceiptBody: string;
    activeStateExactResponseBody?: string | null;
    manifestTerminalRequestBody: string;
    manifestReceiptBody: string;
    manifestExactResponseBody?: string | null;
    providers: readonly CatalogPromotionBootstrapProviderProof[];
    verifiedAt: Date;
  }>): Promise<void> {
    await this.#verify({
      proofKind: "cleared",
      ...input,
      manifestDefinitionRequestBody: null,
    });
  }

  async verifyActive(input: Readonly<{
    activeStateRequestBody: string;
    activeStateReceiptBody: string;
    activeStateExactResponseBody?: string | null;
    manifestDefinitionRequestBody: string;
    manifestTerminalRequestBody: string;
    manifestReceiptBody: string;
    manifestExactResponseBody?: string | null;
    providers: readonly CatalogPromotionBootstrapProviderProof[];
    verifiedAt: Date;
  }>): Promise<void> {
    await this.#verify({ proofKind: "active", ...input });
  }

  async loadProof(): Promise<CatalogPromotionBootstrapProof | null> {
    return loadCatalogPromotionBootstrapProof(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    });
  }

  async #verify(input: Readonly<{
    proofKind: "empty" | "cleared" | "active";
    activeStateRequestBody: string;
    activeStateReceiptBody: string;
    activeStateExactResponseBody?: string | null;
    manifestDefinitionRequestBody: string | null;
    manifestTerminalRequestBody: string | null;
    manifestReceiptBody: string | null;
    manifestExactResponseBody?: string | null;
    providers: readonly CatalogPromotionBootstrapProviderProof[];
    verifiedAt: Date;
  }>): Promise<void> {
    if (!finiteDate(input.verifiedAt)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    const activeRequest = parseExact(
      input.activeStateRequestBody,
      catalogManifestActiveStateRequestSchema,
    );
    const activeReceipt = parseExact(
      input.activeStateReceiptBody,
      catalogManifestActiveStateReceiptSchema,
    );
    const activeRequestSha256 = promotionV2Sha256(input.activeStateRequestBody);
    if (
      activeReceipt.operationId !== activeRequest.operationId ||
      activeReceipt.requestDigest !== activeRequestSha256
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    const activeResponse = validateExactResponse(
      input.activeStateExactResponseBody,
      input.activeStateReceiptBody,
      "manifest",
    );
    const activeState = activeReceipt.details.activeState;
    const activeStateBody = canonicalJson(activeState);
    let manifestRequestSha256: string | null = null;
    let manifestTerminalRequestSha256: string | null = null;
    let manifestReceiptSha256: string | null = null;
    let manifestResponse: Readonly<{ body: string | null; sha256: string | null }> =
      { body: null, sha256: null };
    if (input.proofKind === "empty") {
      if (
        activeState.generation !== 0 || activeState.activeManifest !== null ||
        activeState.previousManifest !== null || activeState.observation !== null ||
        activeState.terminalReceiptSha256 !== null ||
        input.manifestDefinitionRequestBody !== null ||
        input.manifestTerminalRequestBody !== null ||
        input.manifestReceiptBody !== null
      ) throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    } else {
      const terminal = validateManifestTerminalProof({
        ...input,
        proofKind: input.proofKind,
        activeState,
      });
      manifestRequestSha256 = terminal.definitionRequestSha256;
      manifestTerminalRequestSha256 = terminal.terminalRequestSha256;
      manifestReceiptSha256 = terminal.receiptSha256;
      manifestResponse = {
        body: terminal.responseBody,
        sha256: terminal.responseSha256,
      };
    }

    const canonicalProviders = [...input.providers].sort((left, right) =>
      left.platformKey < right.platformKey
        ? -1 : left.platformKey > right.platformKey ? 1 : 0);
    if (canonicalProviders.some((provider, index) =>
      provider !== input.providers[index] ||
      (index > 0 && canonicalProviders[index - 1]!.platformKey ===
        provider.platformKey))) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    await this.database.$transaction(async (transaction) => {
      await lockPromotionConfigurationScope(transaction, {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      });
      await transaction.$executeRaw(Prisma.sql`
        insert into public.manifest_promotion_lanes (organization_id, deployment_key)
        values (${uuid(this.#organizationId)}, ${this.#deploymentKey})
        on conflict do nothing
      `);
      const existing = await transaction.$queryRaw<Array<{
        bootstrapState: string;
        activeStateBody: string | null;
        providerSetBody: string | null;
        providerSetSha256: string | null;
        currentProofRevision: bigint | null;
      }>>(Prisma.sql`
        select bootstrap_state as "bootstrapState",
               active_state_body as "activeStateBody",
               bootstrap_provider_set_body as "providerSetBody",
               bootstrap_provider_set_sha256 as "providerSetSha256",
               current_bootstrap_proof_revision as "currentProofRevision"
        from public.manifest_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
        for update
      `);
      const lane = existing[0]!;
      if (lane.bootstrapState !== "unverified") {
        const currentState = lane.activeStateBody ?? canonicalJson({
          generation: 0, activeManifest: null, previousManifest: null,
          observation: null, terminalReceiptSha256: null,
        });
        if (currentState !== activeStateBody) {
          // The authenticated probe is stale relative to a locally proven
          // transition. The coordinator must re-probe, not hard-fail startup.
          throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
        }
      }
      const eligibility = await loadManifestEligibilitySnapshotInTransaction(
        transaction, { organizationId: this.#organizationId },
      );
      if (!eligibility || canonicalJson(eligibility.configuredPlatformKeys) !==
        canonicalJson(input.providers.map(({ platformKey }) => platformKey))) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      const activatedAt = await this.#validateLocalManifestGraph(transaction, {
        proofKind: input.proofKind,
        activeState,
        manifestDefinitionRequestBody: input.manifestDefinitionRequestBody,
        manifestTerminalRequestBody: input.manifestTerminalRequestBody,
        manifestReceiptBody: input.manifestReceiptBody,
        manifestExactResponseBody: input.manifestExactResponseBody,
      });
      for (const provider of input.providers) {
        await this.#validateProvider(transaction, provider, activeState);
      }
      const providerSetBody = canonicalJson(
        input.providers.map(({ platformKey }) => platformKey),
      );
      if (activeState.observation?.providerSelections.some((selection) =>
        !input.providers.some(({ platformKey }) =>
          platformKey === selection.platformKey)) === true) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      if (lane.bootstrapState !== "unverified" && (
        lane.providerSetBody === null || lane.providerSetSha256 === null ||
        lane.currentProofRevision === null ||
        promotionV2Sha256(lane.providerSetBody) !== lane.providerSetSha256
      )) throw new PromotionV2PersistenceError(
        "PROMOTION_V2_STATE_CONFLICT",
      );
      if (lane.bootstrapState !== "unverified" &&
        lane.providerSetBody === providerSetBody) {
        return;
      }
      const proofRevision = (lane.currentProofRevision ?? 0n) + 1n;
      await transaction.$executeRaw(Prisma.sql`
        insert into public.catalog_promotion_bootstrap_proofs (
          organization_id, deployment_key, proof_revision, proof_kind,
          active_state_request_body, active_state_request_sha256,
          active_state_receipt_body, active_state_receipt_sha256,
          active_state_response_body, active_state_response_sha256,
          manifest_definition_request_body,
          manifest_definition_request_sha256,
          manifest_terminal_request_body,
          manifest_terminal_request_sha256,
          manifest_receipt_body, manifest_receipt_sha256,
          manifest_response_body, manifest_response_sha256,
          active_state_body, active_state_sha256, verified_at
        ) values (
          ${uuid(this.#organizationId)}, ${this.#deploymentKey},
          ${proofRevision}, ${input.proofKind},
          ${input.activeStateRequestBody}, ${activeRequestSha256},
          ${input.activeStateReceiptBody},
          ${promotionV2Sha256(input.activeStateReceiptBody)},
          ${activeResponse.body}, ${activeResponse.sha256},
          ${input.manifestDefinitionRequestBody}, ${manifestRequestSha256},
          ${input.manifestTerminalRequestBody}, ${manifestTerminalRequestSha256},
          ${input.manifestReceiptBody}, ${manifestReceiptSha256},
          ${manifestResponse.body}, ${manifestResponse.sha256},
          ${activeStateBody}, ${promotionV2Sha256(activeStateBody)}, ${input.verifiedAt}
        )
      `);
      for (const [ordinal, provider] of input.providers.entries()) {
        await this.#insertProvider(
          transaction, provider, proofRevision, ordinal,
        );
      }
      if (lane.bootstrapState !== "unverified") {
        await transaction.$executeRaw(Prisma.sql`
          update public.manifest_promotion_lanes
          set bootstrap_provider_set_body = ${providerSetBody},
              bootstrap_provider_set_sha256 = ${promotionV2Sha256(
                providerSetBody,
              )},
              current_bootstrap_proof_revision = ${proofRevision},
              bootstrap_verified_at = ${input.verifiedAt},
              updated_at = ${input.verifiedAt}
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
        `);
        return;
      }
      await applyInitialCatalogPromotionBootstrapState(transaction, {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      }, {
        ...input,
        state: activeState,
        stateBody: activeStateBody,
        receiptSha256: promotionV2Sha256(input.activeStateReceiptBody),
        response: activeResponse,
        activatedAt,
        proofRevision,
      });
    }, {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async #validateProvider(
    transaction: PackscoutTransactionClient,
    proof: CatalogPromotionBootstrapProviderProof,
    activeState: ActiveCatalogManifestStateV1,
  ): Promise<void> {
    const probe = validateProviderProbe(proof);
    const laneRows = await transaction.$queryRaw<Array<{
      completedCheckpoint: bigint;
      completedAttemptId: string | null;
      completedPublicProviderReleaseId: string | null;
      completedProviderReleaseFingerprint: string | null;
      completedTerminalReceiptSha256: string | null;
      completedTerminalOperationKind: "finalize" | "confirmReuse" | null;
      completedTerminalOperationId: string | null;
      completedHeadBody: string | null;
      completedHeadSha256: string | null;
    }>>(Prisma.sql`
      select completed_checkpoint as "completedCheckpoint",
             completed_attempt_id::text as "completedAttemptId",
             completed_public_provider_release_id::text
               as "completedPublicProviderReleaseId",
             completed_provider_release_fingerprint
               as "completedProviderReleaseFingerprint",
             completed_terminal_receipt_sha256
               as "completedTerminalReceiptSha256",
             completed_terminal_operation_kind
               as "completedTerminalOperationKind",
             completed_terminal_operation_id as "completedTerminalOperationId",
             completed_head_body as "completedHeadBody",
             completed_head_sha256 as "completedHeadSha256"
      from public.provider_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and platform_key = ${proof.platformKey}
    `);
    const lane = laneRows[0];
    if (probe.remoteHead.release === null) {
      if (lane && lane.completedCheckpoint !== 0n ||
        proof.localCompletedHead !== null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
    } else {
      let localHead;
      try {
        localHead = lane?.completedHeadBody === null || lane === undefined
          ? null
          : providerReleaseCompletedHeadResultV1Schema.parse(
              JSON.parse(lane.completedHeadBody),
            );
      } catch {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      const local = proof.localCompletedHead;
      if (
        !lane || localHead === null || local === null ||
        lane.completedHeadSha256 === null ||
        promotionV2Sha256(lane.completedHeadBody!) !== lane.completedHeadSha256 ||
        canonicalJson(probe.remoteHead) !== canonicalJson({
          ...localHead,
          terminalReceiptSha256: lane.completedTerminalReceiptSha256,
        }) ||
        probe.remoteHead.release.publicProviderReleaseId !==
          lane.completedPublicProviderReleaseId ||
        probe.remoteHead.release.providerReleaseFingerprint !==
          lane.completedProviderReleaseFingerprint ||
        probe.remoteHead.providerCheckpoint.settledSequence !==
          String(lane.completedCheckpoint) ||
        probe.remoteHead.terminalReceiptSha256 !==
          lane.completedTerminalReceiptSha256 ||
        local.attemptId !== lane.completedAttemptId ||
        local.publicProviderReleaseId !==
          lane.completedPublicProviderReleaseId ||
        local.providerReleaseFingerprint !==
          lane.completedProviderReleaseFingerprint ||
        local.terminalReceiptSha256 !== lane.completedTerminalReceiptSha256
      ) throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      if (lane.completedTerminalOperationKind === null ||
        lane.completedTerminalOperationId === null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      const completedRows = await transaction.$queryRaw<Array<{
        operationKind: "finalize" | "confirmReuse";
        requestBody: string;
        requestSha256: string;
        receiptBody: string;
        receiptSha256: string;
        exactResponseBody: string | null;
        responseSha256: string | null;
        attemptState: string;
        artifactFingerprint: string;
      }>>(Prisma.sql`
        select operation.operation_kind as "operationKind",
               operation.canonical_request_body as "requestBody",
               operation.request_sha256 as "requestSha256",
               operation.canonical_receipt_body as "receiptBody",
               operation.receipt_sha256 as "receiptSha256",
               operation.exact_response_body as "exactResponseBody",
               operation.response_sha256 as "responseSha256",
               attempt.state as "attemptState",
               artifact.provider_release_fingerprint as "artifactFingerprint"
        from public.provider_promotion_attempts as attempt
        join public.provider_promotion_operations as operation
          on operation.attempt_id = attempt.id
         and operation.organization_id = attempt.organization_id
         and operation.deployment_key = attempt.deployment_key
         and operation.platform_key = attempt.platform_key
         and operation.operation_id = ${lane.completedTerminalOperationId}
         and operation.operation_kind = ${lane.completedTerminalOperationKind}
         and operation.state = 'acknowledged'
        join public.provider_release_artifacts as artifact
          on artifact.organization_id = attempt.organization_id
         and artifact.deployment_key = attempt.deployment_key
         and artifact.platform_key = attempt.platform_key
         and artifact.public_provider_release_id = ${uuid(
           lane.completedPublicProviderReleaseId!
         )}
         and artifact.provider_release_fingerprint = ${
           lane.completedProviderReleaseFingerprint
         }
        where attempt.id = ${uuid(lane.completedAttemptId!)}
          and attempt.organization_id = ${uuid(this.#organizationId)}
          and attempt.deployment_key = ${this.#deploymentKey}
          and attempt.platform_key = ${proof.platformKey}
      `);
      const completed = completedRows[0];
      if (!completed || completedRows.length !== 1 ||
        completed.receiptSha256 !== lane.completedTerminalReceiptSha256 ||
        promotionV2Sha256(completed.requestBody) !== completed.requestSha256 ||
        promotionV2Sha256(completed.receiptBody) !== completed.receiptSha256 ||
        (completed.exactResponseBody === null) !==
          (completed.responseSha256 === null) ||
        (completed.exactResponseBody !== null &&
          promotionV2Sha256(completed.exactResponseBody) !==
            completed.responseSha256) ||
        completed.attemptState !==
          (completed.operationKind === "finalize" ? "published" : "reused") ||
        completed.artifactFingerprint !==
          lane.completedProviderReleaseFingerprint) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      const completedRequest = parseProviderTerminalRequest(
        completed.requestBody,
        completed.operationKind,
      );
      const completedReceipt = parseExact(
        completed.receiptBody,
        providerReleaseReceiptSchema,
      );
      if (completedReceipt.operationKind !== completed.operationKind ||
        completedReceipt.operationId !== completedRequest.operationId ||
        completedReceipt.idempotencyKey !== completedRequest.idempotencyKey ||
        completedReceipt.requestDigest !== completed.requestSha256 ||
        completedRequest.release.platformKey !== proof.platformKey ||
        completedRequest.release.publicProviderReleaseId !==
          lane.completedPublicProviderReleaseId ||
        completedRequest.release.providerReleaseFingerprint !==
          lane.completedProviderReleaseFingerprint ||
        canonicalJson(completedReceipt.details.release) !==
          canonicalJson(completedRequest.release) ||
        canonicalJson(completedReceipt.details.providerCheckpoint) !==
          canonicalJson(completedRequest.providerCheckpoint) ||
        canonicalJson(completedReceipt.details.observation) !==
          canonicalJson(completedRequest.observation) ||
        completedReceipt.details.sourceWatermark !==
          completedRequest.sourceWatermark ||
        canonicalJson(completedReceipt.details.expectedCompletedHead) !==
          canonicalJson(completedRequest.expectedCompletedHead) ||
        !("completedHead" in completedReceipt.details) ||
        canonicalJson(completedReceipt.details.completedHead) !==
          lane.completedHeadBody) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
    }

    const selection = activeState.observation?.providerSelections.find(
      ({ platformKey }) => platformKey === proof.platformKey,
    ) ?? null;
    if ((selection === null) !== (proof.activeReference === null)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    if (selection !== null && proof.activeReference !== null) {
      if (
        selection.publicProviderReleaseId !==
          proof.activeReference.publicProviderReleaseId ||
        selection.terminalOperationId !==
          proof.activeReference.providerTerminalOperationId ||
        selection.terminalReceiptSha256 !==
          proof.activeReference.providerTerminalReceiptSha256 ||
        promotionV2Sha256(proof.activeReference.providerTerminalReceiptBody) !==
          proof.activeReference.providerTerminalReceiptSha256
      ) throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      const receipt = parseExact(
        proof.activeReference.providerTerminalReceiptBody,
        providerReleaseReceiptSchema,
      );
      const localRows = await transaction.$queryRaw<Array<{
        requestBody: string;
        requestSha256: string;
        receiptBody: string;
        receiptSha256: string;
        exactResponseBody: string | null;
        responseSha256: string | null;
        attemptState: string;
        artifactFingerprint: string;
        publishArtifactAttemptId: string;
      }>>(
        Prisma.sql`
          select operation.canonical_request_body as "requestBody",
                 operation.request_sha256 as "requestSha256",
                 operation.canonical_receipt_body as "receiptBody",
                 operation.receipt_sha256 as "receiptSha256",
                 operation.exact_response_body as "exactResponseBody",
                 operation.response_sha256 as "responseSha256",
                 attempt.state as "attemptState",
                 artifact.provider_release_fingerprint as "artifactFingerprint",
                 artifact.publish_attempt_id::text as "publishArtifactAttemptId"
          from public.provider_promotion_operations as operation
          join public.provider_promotion_attempts as attempt
            on attempt.id = operation.attempt_id
           and attempt.organization_id = operation.organization_id
           and attempt.deployment_key = operation.deployment_key
           and attempt.platform_key = operation.platform_key
          join public.provider_release_artifacts as artifact
            on artifact.organization_id = operation.organization_id
           and artifact.deployment_key = operation.deployment_key
           and artifact.platform_key = operation.platform_key
           and artifact.publish_attempt_id = ${uuid(
             proof.activeReference.publishArtifactAttemptId
           )}
           and artifact.public_provider_release_id = ${uuid(
              proof.activeReference.publicProviderReleaseId,
            )}
           and artifact.provider_release_fingerprint = ${
              proof.activeReference.providerReleaseFingerprint
            }
          where operation.organization_id = ${uuid(this.#organizationId)}
            and operation.deployment_key = ${this.#deploymentKey}
            and operation.platform_key = ${proof.platformKey}
            and operation.operation_id = ${selection.terminalOperationId}
            and operation.operation_kind = ${selection.terminalOperationKind}
            and operation.state = 'acknowledged'
        `,
      );
      const local = localRows[0];
      if (!local || localRows.length !== 1 ||
        local.receiptBody !== proof.activeReference.providerTerminalReceiptBody ||
        local.receiptSha256 !==
          proof.activeReference.providerTerminalReceiptSha256 ||
        promotionV2Sha256(local.requestBody) !== local.requestSha256 ||
        promotionV2Sha256(local.receiptBody) !== local.receiptSha256 ||
        local.exactResponseBody !==
          (proof.activeReference.providerTerminalResponseBody ?? null) ||
        (local.exactResponseBody === null) !== (local.responseSha256 === null) ||
        (local.exactResponseBody !== null &&
          promotionV2Sha256(local.exactResponseBody) !== local.responseSha256) ||
        local.attemptState !== (selection.terminalOperationKind === "finalize"
          ? "published" : "reused") ||
        local.artifactFingerprint !==
          proof.activeReference.providerReleaseFingerprint ||
        local.publishArtifactAttemptId !==
          proof.activeReference.publishArtifactAttemptId ||
        receipt.operationId !== selection.terminalOperationId ||
        receipt.operationKind !== selection.terminalOperationKind ||
        receipt.publicProviderReleaseId !== selection.publicProviderReleaseId) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      const request = parseProviderTerminalRequest(
        local.requestBody,
        selection.terminalOperationKind,
      );
      if (request.operationId !== receipt.operationId ||
        request.idempotencyKey !== receipt.idempotencyKey ||
        local.requestSha256 !== receipt.requestDigest ||
        request.release.platformKey !== proof.platformKey ||
        request.release.publicProviderReleaseId !==
          proof.activeReference.publicProviderReleaseId ||
        request.release.providerReleaseFingerprint !==
          proof.activeReference.providerReleaseFingerprint ||
        canonicalJson(request.release) !== canonicalJson(receipt.details.release) ||
        canonicalJson(request.providerCheckpoint) !==
          canonicalJson(receipt.details.providerCheckpoint) ||
        canonicalJson(request.providerCheckpoint) !==
          canonicalJson(selection.selectedProviderCheckpoint) ||
        canonicalJson(request.observation) !==
          canonicalJson(receipt.details.observation) ||
        request.sourceWatermark !== receipt.details.sourceWatermark ||
        canonicalJson(request.expectedCompletedHead) !==
          canonicalJson(receipt.details.expectedCompletedHead)) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
      }
      validateExactResponse(
        proof.activeReference.providerTerminalResponseBody,
        proof.activeReference.providerTerminalReceiptBody,
        "provider",
      );
    }
  }

  async #insertProvider(
    transaction: PackscoutTransactionClient,
    proof: CatalogPromotionBootstrapProviderProof,
    proofRevision: bigint,
    ordinal: number,
  ): Promise<void> {
    const probe = validateProviderProbe(proof);
    const active = proof.activeReference;
    const local = proof.localCompletedHead;
    const activeResponse = active === null ? { body: null, sha256: null } :
      validateExactResponse(
        active.providerTerminalResponseBody,
        active.providerTerminalReceiptBody,
        "provider",
      );
    const remoteHeadBody = canonicalJson(probe.remoteHead);
    await transaction.$executeRaw(Prisma.sql`
      insert into public.catalog_promotion_bootstrap_provider_proofs (
        organization_id, deployment_key, proof_revision, platform_key, ordinal,
        public_provider_release_id, provider_release_fingerprint,
        provider_terminal_operation_id, provider_terminal_receipt_body,
        provider_terminal_receipt_sha256, provider_terminal_response_body,
        provider_terminal_response_sha256, publish_artifact_attempt_id,
        completed_head_request_body, completed_head_request_sha256,
        completed_head_receipt_body, completed_head_receipt_sha256,
        completed_head_response_body, completed_head_response_sha256,
        remote_completed_head_body, remote_completed_head_sha256,
        local_completed_attempt_id, local_completed_public_provider_release_id,
        local_completed_provider_release_fingerprint,
        local_completed_terminal_receipt_sha256
      ) values (
        ${uuid(this.#organizationId)}, ${this.#deploymentKey},
        ${proofRevision}, ${proof.platformKey}, ${ordinal},
        ${active === null ? Prisma.sql`null` : uuid(active.publicProviderReleaseId)},
        ${active?.providerReleaseFingerprint ?? null},
        ${active?.providerTerminalOperationId ?? null},
        ${active?.providerTerminalReceiptBody ?? null},
        ${active?.providerTerminalReceiptSha256 ?? null},
        ${activeResponse.body}, ${activeResponse.sha256},
        ${active === null ? Prisma.sql`null` : uuid(active.publishArtifactAttemptId)},
        ${proof.completedHeadProbe.requestBody}, ${probe.requestSha256},
        ${proof.completedHeadProbe.receiptBody}, ${probe.receiptSha256},
        ${probe.responseBody}, ${probe.responseSha256},
        ${remoteHeadBody}, ${promotionV2Sha256(remoteHeadBody)},
        ${local === null ? Prisma.sql`null` : uuid(local.attemptId)},
        ${local === null ? Prisma.sql`null` : uuid(local.publicProviderReleaseId)},
        ${local?.providerReleaseFingerprint ?? null},
        ${local?.terminalReceiptSha256 ?? null}
      )
    `);
  }

}
