import {
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestReceiptDigest,
  catalogManifestReceiptSchema,
  catalogManifestSignedReceiptEnvelopeSchema,
  globalCatalogProviderReferenceV1Schema,
  productionHeatManifestAlignmentSchema,
  recomputeGlobalCatalogProviderReferenceSetHashV1,
  verifyGlobalCatalogManifestV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderReferenceV1,
  type ProductionHeatManifestAlignment,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  proveActiveCatalogProviderRepacks,
  type ActiveCatalogPublicRepackOwnership,
} from "./active-catalog-heat-provider-proof.ts";
import { loadCatalogPromotionBootstrapProof } from
  "./catalog-promotion-bootstrap-proof-read.ts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
} from "./database.ts";
import {
  parseManifestPromotionPreparedSummary,
  parseManifestPromotionReceiptEvidence,
  validateManifestPromotionPrepared,
  validateManifestSummaryAgainstProjection,
  type ManifestPromotionOperationRow,
} from "./manifest-promotion-repository-validation.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function invalidProof(): never {
  throw new Error("Promotion release proof is invalid.");
}

export interface ActiveCatalogHeatManifest {
  readonly manifestAlignment: ProductionHeatManifestAlignment;
  readonly providerReferences: readonly GlobalCatalogProviderReferenceV1[];
  readonly publicRepackOwnership:
    readonly ActiveCatalogPublicRepackOwnership[];
  readonly publicRepackIds: readonly string[];
  readonly confirmedManifestWatermark: bigint;
  readonly terminalReceiptSha256: string;
}

export const HEAT_MANIFEST_SOURCE_PROOF_SCHEMA_VERSION =
  "heat_manifest_source_proof_v1" as const;
export const MAX_HEAT_MANIFEST_SOURCE_PROOF_BYTES = 4 * 1_024 * 1_024;

export interface SerializedHeatManifestSourceProof {
  readonly canonicalBody: string;
  readonly sha256: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const unsignedInt64Pattern = /^(?:0|[1-9][0-9]{0,18})$/u;
const maximumSignedInt64 = 9_223_372_036_854_775_807n;

function invalidSourceProof(): never {
  throw new Error("Heat manifest source proof is invalid.");
}

function sourceProofDocument(input: ActiveCatalogHeatManifest) {
  return {
    schemaVersion: HEAT_MANIFEST_SOURCE_PROOF_SCHEMA_VERSION,
    manifestAlignment: input.manifestAlignment,
    confirmedManifestWatermark: input.confirmedManifestWatermark.toString(),
    terminalReceiptSha256: input.terminalReceiptSha256,
    providerReferences: input.providerReferences,
    publicRepackOwnership: input.publicRepackOwnership,
    publicRepackIds: input.publicRepackIds,
  };
}

async function validateHeatManifestSourceProof(
  input: ActiveCatalogHeatManifest,
): Promise<ActiveCatalogHeatManifest> {
  let manifestAlignment;
  let providerReferences;
  try {
    manifestAlignment = productionHeatManifestAlignmentSchema.parse(
      input.manifestAlignment,
    );
    providerReferences = input.providerReferences.map((reference) =>
      globalCatalogProviderReferenceV1Schema.parse(reference)
    );
  } catch {
    invalidSourceProof();
  }
  if (
    input.confirmedManifestWatermark < 0n ||
    input.confirmedManifestWatermark > maximumSignedInt64 ||
    !sha256Pattern.test(input.terminalReceiptSha256) ||
    providerReferences.length === 0 ||
    providerReferences.some((reference, index) =>
      index > 0 && reference.platformKey <=
        providerReferences[index - 1]!.platformKey
    ) ||
    canonicalJson(providerReferences.map(({ sharedConfigurationEpoch }) =>
      sharedConfigurationEpoch
    )) !== canonicalJson(providerReferences.map(() =>
      manifestAlignment.sharedConfigurationEpoch
    )) ||
    await recomputeGlobalCatalogProviderReferenceSetHashV1(
      providerReferences,
    ) !== manifestAlignment.providerReferenceSetHash ||
    input.publicRepackOwnership.length > MAX_PUBLIC_REPACKS_PER_RELEASE ||
    input.publicRepackOwnership.length !== providerReferences.reduce(
      (count, reference) => count + reference.counts.repacks,
      0,
    ) ||
    input.publicRepackIds.length !== input.publicRepackOwnership.length
  ) invalidSourceProof();

  const referencesByPlatform = new Map(providerReferences.map((reference) =>
    [reference.platformKey, reference] as const
  ));
  const ownership = input.publicRepackOwnership.map((candidate, index) => {
    const reference = referencesByPlatform.get(candidate.platformKey);
    const previous = input.publicRepackOwnership[index - 1];
    if (
      Object.keys(candidate).sort().join(",") !==
        "platformKey,providerReleaseFingerprint,publicProviderReleaseId,publicRepackId" ||
      !uuidPattern.test(candidate.publicRepackId) ||
      !uuidPattern.test(candidate.publicProviderReleaseId) ||
      !sha256Pattern.test(candidate.providerReleaseFingerprint) ||
      reference === undefined ||
      candidate.publicProviderReleaseId !== reference.publicProviderReleaseId ||
      candidate.providerReleaseFingerprint !==
        reference.providerReleaseFingerprint ||
      (previous !== undefined && (
        candidate.platformKey < previous.platformKey ||
        (candidate.platformKey === previous.platformKey &&
          candidate.publicRepackId <= previous.publicRepackId)
      ))
    ) invalidSourceProof();
    return Object.freeze({
      publicRepackId: candidate.publicRepackId.toLowerCase(),
      platformKey: candidate.platformKey,
      publicProviderReleaseId: candidate.publicProviderReleaseId.toLowerCase(),
      providerReleaseFingerprint: candidate.providerReleaseFingerprint,
    });
  });
  const publicRepackIds = ownership.map(({ publicRepackId }) => publicRepackId)
    .sort();
  if (
    publicRepackIds.some((id, index) => index > 0 &&
      id === publicRepackIds[index - 1]) ||
    canonicalJson(publicRepackIds) !== canonicalJson(input.publicRepackIds)
  ) invalidSourceProof();
  return Object.freeze({
    manifestAlignment: Object.freeze(manifestAlignment),
    providerReferences: Object.freeze(providerReferences),
    publicRepackOwnership: Object.freeze(ownership),
    publicRepackIds: Object.freeze(publicRepackIds),
    confirmedManifestWatermark: input.confirmedManifestWatermark,
    terminalReceiptSha256: input.terminalReceiptSha256,
  });
}

export async function serializeHeatManifestSourceProof(
  input: ActiveCatalogHeatManifest,
): Promise<SerializedHeatManifestSourceProof> {
  const proven = await validateHeatManifestSourceProof(input);
  const canonicalBody = canonicalJson(sourceProofDocument(proven));
  if (Buffer.byteLength(canonicalBody, "utf8") >
    MAX_HEAT_MANIFEST_SOURCE_PROOF_BYTES) invalidSourceProof();
  return Object.freeze({
    canonicalBody,
    sha256: promotionV2Sha256(canonicalBody),
  });
}

export async function parseHeatManifestSourceProof(
  canonicalBody: string,
  expectedSha256: string,
): Promise<ActiveCatalogHeatManifest> {
  if (
    Buffer.byteLength(canonicalBody, "utf8") >
      MAX_HEAT_MANIFEST_SOURCE_PROOF_BYTES ||
    !sha256Pattern.test(expectedSha256) ||
    promotionV2Sha256(canonicalBody) !== expectedSha256
  ) invalidSourceProof();
  let document: unknown;
  try {
    document = JSON.parse(canonicalBody) as unknown;
  } catch {
    invalidSourceProof();
  }
  if (document === null || typeof document !== "object" ||
    Array.isArray(document)) invalidSourceProof();
  const value = document as Record<string, unknown>;
  if (
    value.schemaVersion !== HEAT_MANIFEST_SOURCE_PROOF_SCHEMA_VERSION ||
    typeof value.confirmedManifestWatermark !== "string" ||
    !unsignedInt64Pattern.test(value.confirmedManifestWatermark) ||
    typeof value.terminalReceiptSha256 !== "string" ||
    !Array.isArray(value.providerReferences) ||
    !Array.isArray(value.publicRepackOwnership) ||
    !Array.isArray(value.publicRepackIds)
  ) invalidSourceProof();
  const proven = await validateHeatManifestSourceProof({
    manifestAlignment: value.manifestAlignment as ProductionHeatManifestAlignment,
    confirmedManifestWatermark: BigInt(value.confirmedManifestWatermark),
    terminalReceiptSha256: value.terminalReceiptSha256,
    providerReferences: value.providerReferences as GlobalCatalogProviderReferenceV1[],
    publicRepackOwnership:
      value.publicRepackOwnership as ActiveCatalogPublicRepackOwnership[],
    publicRepackIds: value.publicRepackIds as string[],
  });
  if (canonicalJson(sourceProofDocument(proven)) !== canonicalBody) {
    invalidSourceProof();
  }
  return proven;
}

interface ManifestLaneProofRow {
  bootstrapState: string;
  confirmedEvaluationSequence: bigint;
  activeGeneration: bigint;
  activeStateBody: string;
  activeStateSha256: string;
  activeStateReceiptBody: string;
  activeStateReceiptSha256: string;
  activeStateResponseBody: string | null;
  activeStateResponseSha256: string | null;
  activePublicReleaseId: string;
  activeManifestFingerprint: string;
  activeProviderReferenceSetHash: string;
  activeConfigurationEpochSequence: bigint;
  activeTerminalReceiptSha256: string;
}

interface ManifestAttemptOperationProofRow extends ManifestPromotionOperationRow {
  attemptId: string;
  evaluationSequence: bigint;
  attemptState: string;
  preparedSummaryBody: string | null;
  preparedSummarySha256: string | null;
  evaluationSnapshotBody: string | null;
  evaluationSnapshotSha256: string | null;
  terminalAt: Date | null;
}

interface ConfirmedManifestAttemptRow {
  id: string;
  state: string;
  preparedSummaryBody: string | null;
  preparedSummarySha256: string | null;
  evaluationSnapshotBody: string | null;
  evaluationSnapshotSha256: string | null;
  terminalAt: Date | null;
  operationCount: number;
}

function operationInput(operation: ManifestAttemptOperationProofRow) {
  return {
    operationIndex: operation.operationIndex,
    operationId: operation.operationId,
    operationKind: operation.operationKind,
    requestPath: operation.requestPath,
    canonicalRequestBody: operation.canonicalRequestBody,
  };
}

function stateCore(state: ReturnType<
  typeof activeCatalogManifestStateV1Schema.parse
>) {
  return {
    generation: state.generation,
    activeManifest: state.activeManifest,
    previousManifest: state.previousManifest,
    observation: state.observation,
  };
}

async function validateManifestAttemptOperation(
  operation: ManifestAttemptOperationProofRow,
) {
  if (
    operation.operationIndex !== 0 ||
    operation.state !== "acknowledged" ||
    operation.canonicalReceiptBody === null ||
    operation.receiptSha256 === null ||
    operation.preparedSummaryBody === null ||
    operation.preparedSummarySha256 === null ||
    operation.evaluationSnapshotBody === null ||
    operation.evaluationSnapshotSha256 === null ||
    operation.terminalAt === null ||
    promotionV2Sha256(operation.canonicalRequestBody) !==
      operation.requestSha256 ||
    promotionV2Sha256(operation.canonicalReceiptBody) !==
      operation.receiptSha256 ||
    promotionV2Sha256(operation.preparedSummaryBody) !==
      operation.preparedSummarySha256 ||
    promotionV2Sha256(operation.evaluationSnapshotBody) !==
      operation.evaluationSnapshotSha256 ||
    (operation.exactResponseBody === null) !==
      (operation.responseSha256 === null) ||
    (operation.exactResponseBody !== null &&
      promotionV2Sha256(operation.exactResponseBody) !==
        operation.responseSha256)
  ) invalidProof();
  let summary;
  let parsed;
  try {
    summary = parseManifestPromotionPreparedSummary(
      operation.preparedSummaryBody,
    );
    validateManifestPromotionPrepared(summary, operationInput(operation));
    validateManifestSummaryAgainstProjection(
      summary,
      operation.evaluationSnapshotBody,
      operation.evaluationSnapshotSha256,
      operationInput(operation),
    );
    parsed = parseManifestPromotionReceiptEvidence(operation, {
      canonicalReceiptBody: operation.canonicalReceiptBody,
      exactResponseBody: operation.exactResponseBody,
    });
  } catch {
    invalidProof();
  }
  const expectedState = parsed.receipt.result;
  if (
    operation.attemptState !== expectedState ||
    parsed.receiptSha256 !== operation.receiptSha256 ||
    parsed.responseSha256 !== operation.responseSha256 ||
    await catalogManifestReceiptDigest(parsed.receipt) !==
      parsed.receipt.receiptDigest
  ) invalidProof();
  return parsed.receipt;
}

async function validateConfirmedManifestWatermark(
  database: PackscoutQueryClient,
  binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  confirmedEvaluationSequence: bigint,
  activeStateBody: string,
): Promise<void> {
  if (confirmedEvaluationSequence === 0n) return;
  const rows = await database.$queryRaw<ConfirmedManifestAttemptRow[]>(Prisma.sql`
    select attempt.id::text as id, attempt.state,
           attempt.prepared_summary_body as "preparedSummaryBody",
           attempt.prepared_summary_sha256 as "preparedSummarySha256",
           attempt.evaluation_snapshot_body as "evaluationSnapshotBody",
           attempt.evaluation_snapshot_sha256 as "evaluationSnapshotSha256",
           attempt.terminal_at as "terminalAt",
           count(operation.id)::integer as "operationCount"
    from public.manifest_promotion_attempts as attempt
    left join public.manifest_promotion_operations as operation
      on operation.attempt_id = attempt.id
     and operation.organization_id = attempt.organization_id
     and operation.deployment_key = attempt.deployment_key
    where attempt.organization_id = ${uuid(binding.organizationId)}
      and attempt.deployment_key = ${binding.deploymentKey}
      and attempt.evaluation_sequence = ${confirmedEvaluationSequence}
    group by attempt.id
  `);
  const attempt = rows[0];
  if (rows.length !== 1 || !attempt || attempt.terminalAt === null) {
    invalidProof();
  }
  if (attempt.state !== "no_change") {
    const operations = await loadManifestOperations(
      database,
      binding,
      Prisma.sql`operation.attempt_id = ${uuid(attempt.id)}`,
    );
    if (attempt.operationCount !== 1 || operations.length !== 1) {
      invalidProof();
    }
    const receipt = await validateManifestAttemptOperation(operations[0]!);
    let activeState;
    try {
      activeState = activeCatalogManifestStateV1Schema.parse(
        JSON.parse(activeStateBody) as unknown,
      );
    } catch {
      invalidProof();
    }
    if (
      receipt.operationKind === "activeState" ||
      receipt.operationKind === "block" ||
      !("activeState" in receipt.details) ||
      canonicalJson(receipt.details.activeState) !==
        canonicalJson(stateCore(activeState))
    ) invalidProof();
    return;
  }
  if (
    attempt.operationCount !== 0 ||
    attempt.preparedSummaryBody === null ||
    attempt.preparedSummarySha256 === null ||
    attempt.evaluationSnapshotBody === null ||
    attempt.evaluationSnapshotSha256 === null ||
    promotionV2Sha256(attempt.preparedSummaryBody) !==
      attempt.preparedSummarySha256 ||
    promotionV2Sha256(attempt.evaluationSnapshotBody) !==
      attempt.evaluationSnapshotSha256
  ) invalidProof();
  try {
    const summary = parseManifestPromotionPreparedSummary(
      attempt.preparedSummaryBody,
    );
    validateManifestPromotionPrepared(summary, null);
    validateManifestSummaryAgainstProjection(
      summary,
      attempt.evaluationSnapshotBody,
      attempt.evaluationSnapshotSha256,
      null,
    );
    if (canonicalJson(summary.expectedActiveState) !== activeStateBody) {
      invalidProof();
    }
  } catch {
    invalidProof();
  }
}

async function loadManifestOperations(
  database: PackscoutQueryClient,
  binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  predicate: Prisma.Sql,
): Promise<ManifestAttemptOperationProofRow[]> {
  return database.$queryRaw<ManifestAttemptOperationProofRow[]>(Prisma.sql`
    select operation.attempt_id::text as "attemptId",
           attempt.evaluation_sequence as "evaluationSequence",
           attempt.state as "attemptState",
           attempt.prepared_summary_body as "preparedSummaryBody",
           attempt.prepared_summary_sha256 as "preparedSummarySha256",
           attempt.evaluation_snapshot_body as "evaluationSnapshotBody",
           attempt.evaluation_snapshot_sha256 as "evaluationSnapshotSha256",
           attempt.terminal_at as "terminalAt",
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
    from public.manifest_promotion_operations as operation
    join public.manifest_promotion_attempts as attempt
      on attempt.id = operation.attempt_id
     and attempt.organization_id = operation.organization_id
     and attempt.deployment_key = operation.deployment_key
    where operation.organization_id = ${uuid(binding.organizationId)}
      and operation.deployment_key = ${binding.deploymentKey}
      and ${predicate}
  `);
}

async function proveCurrentManifest(
  database: PackscoutQueryClient,
  binding: Readonly<{ organizationId: string; deploymentKey: string }>,
): Promise<ActiveCatalogHeatManifest | null> {
  let bootstrapProof;
  try {
    bootstrapProof = await loadCatalogPromotionBootstrapProof(
      database, binding,
    );
  } catch {
    invalidProof();
  }
  const rows = await database.$queryRaw<ManifestLaneProofRow[]>(Prisma.sql`
    select bootstrap_state as "bootstrapState",
           confirmed_evaluation_sequence as "confirmedEvaluationSequence",
           active_generation as "activeGeneration",
           active_state_body as "activeStateBody",
           active_state_sha256 as "activeStateSha256",
           active_state_receipt_body as "activeStateReceiptBody",
           active_state_receipt_sha256 as "activeStateReceiptSha256",
           active_state_response_body as "activeStateResponseBody",
           active_state_response_sha256 as "activeStateResponseSha256",
           active_public_release_id::text as "activePublicReleaseId",
           active_manifest_fingerprint as "activeManifestFingerprint",
           active_provider_reference_set_hash as "activeProviderReferenceSetHash",
           active_configuration_epoch_sequence
             as "activeConfigurationEpochSequence",
           active_terminal_receipt_sha256 as "activeTerminalReceiptSha256"
    from public.manifest_promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
      and bootstrap_state = 'verified_active'
  `);
  const lane = rows[0];
  if (!lane) return null;
  if (rows.length !== 1 || bootstrapProof === null ||
    promotionV2Sha256(lane.activeStateBody) !== lane.activeStateSha256 ||
    promotionV2Sha256(lane.activeStateReceiptBody) !==
      lane.activeStateReceiptSha256 ||
    (lane.activeStateResponseBody === null) !==
      (lane.activeStateResponseSha256 === null) ||
    (lane.activeStateResponseBody !== null &&
      promotionV2Sha256(lane.activeStateResponseBody) !==
        lane.activeStateResponseSha256)) invalidProof();

  let state;
  let stateReceipt;
  try {
    state = activeCatalogManifestStateV1Schema.parse(
      JSON.parse(lane.activeStateBody) as unknown,
    );
    stateReceipt = catalogManifestReceiptSchema.parse(
      JSON.parse(lane.activeStateReceiptBody) as unknown,
    );
  } catch {
    invalidProof();
  }
  const active = state.activeManifest;
  const observation = state.observation;
  if (
    canonicalJson(state) !== lane.activeStateBody ||
    canonicalJson(stateReceipt) !== lane.activeStateReceiptBody ||
    await catalogManifestReceiptDigest(stateReceipt) !==
      stateReceipt.receiptDigest ||
    active === null || observation === null ||
    BigInt(state.generation) !== lane.activeGeneration ||
    active.publicReleaseId !== lane.activePublicReleaseId ||
    active.manifestFingerprint !== lane.activeManifestFingerprint ||
    active.providerReferenceSetHash !== lane.activeProviderReferenceSetHash ||
    BigInt(active.sharedConfigurationEpoch.publicChangeSequence) !==
      lane.activeConfigurationEpochSequence ||
    state.terminalReceiptSha256 !== lane.activeTerminalReceiptSha256 ||
    (stateReceipt.operationKind === "activeState"
      ? canonicalJson(stateReceipt.details.activeState) !== lane.activeStateBody
      : !("activeState" in stateReceipt.details) ||
        canonicalJson(stateReceipt.details.activeState) !==
          canonicalJson(stateCore(state)))
  ) invalidProof();
  if (lane.activeStateResponseBody !== null) {
    try {
      const response = catalogManifestSignedReceiptEnvelopeSchema.parse(
        JSON.parse(lane.activeStateResponseBody) as unknown,
      );
      if (canonicalJson(response.receipt) !== lane.activeStateReceiptBody) {
        invalidProof();
      }
    } catch {
      invalidProof();
    }
  }

  const terminalOperations = await loadManifestOperations(
    database,
    binding,
    Prisma.sql`operation.state = 'acknowledged'
      and operation.receipt_sha256 = ${lane.activeTerminalReceiptSha256}`,
  );
  if (terminalOperations.length !== 1) invalidProof();
  const terminalReceipt = await validateManifestAttemptOperation(
    terminalOperations[0]!,
  );
  if (
    terminalReceipt.operationKind === "activeState" ||
    terminalReceipt.operationKind === "block" ||
    !("activeState" in terminalReceipt.details) ||
    canonicalJson(terminalReceipt.details.activeState) !==
      canonicalJson(stateCore(state))
  ) invalidProof();

  const definitionOperations = await loadManifestOperations(
    database,
    binding,
    Prisma.sql`operation.operation_kind = 'activateManifest'
      and operation.request_path = ${PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest}
      and operation.state = 'acknowledged'
      and attempt.public_release_id = ${uuid(active.publicReleaseId)}`,
  );
  const definitions: GlobalCatalogManifestV1[] = [];
  for (const operation of definitionOperations) {
    await validateManifestAttemptOperation(operation);
    let request;
    try {
      request = catalogManifestActivateRequestSchema.parse(
        JSON.parse(operation.canonicalRequestBody) as unknown,
      );
      if (canonicalJson(request) !== operation.canonicalRequestBody) {
        invalidProof();
      }
      definitions.push(await verifyGlobalCatalogManifestV1(request.manifest));
    } catch {
      invalidProof();
    }
  }
  const manifest = definitions[0];
  if (!manifest || definitions.some((definition) =>
    canonicalJson(definition) !== canonicalJson(manifest)) ||
    canonicalJson({
      publicReleaseId: manifest.publicReleaseId,
      manifestFingerprint: manifest.manifestFingerprint,
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
    }) !== canonicalJson({
      publicReleaseId: active.publicReleaseId,
      manifestFingerprint: active.manifestFingerprint,
      sharedConfigurationEpoch: active.sharedConfigurationEpoch,
      providerReferenceSetHash: active.providerReferenceSetHash,
    })) invalidProof();

  await validateConfirmedManifestWatermark(
    database,
    binding,
    lane.confirmedEvaluationSequence,
    lane.activeStateBody,
  );
  const repacks = await proveActiveCatalogProviderRepacks(database, binding, {
    manifest,
    activeGeneration: lane.activeGeneration,
    activeSelections: observation.providerSelections,
  });
  const manifestAlignment = productionHeatManifestAlignmentSchema.parse({
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
  });
  return Object.freeze({
    manifestAlignment: Object.freeze(manifestAlignment),
    providerReferences: Object.freeze([...manifest.providerReferences]),
    publicRepackOwnership: repacks.publicRepackOwnership,
    publicRepackIds: repacks.publicRepackIds,
    confirmedManifestWatermark: lane.confirmedEvaluationSequence,
    terminalReceiptSha256: lane.activeTerminalReceiptSha256,
  });
}

function isPrismaClient(
  database: PackscoutQueryClient,
): database is PackscoutPrismaClient {
  return "$transaction" in database;
}

export async function loadActiveCatalogHeatManifest(
  database: PackscoutQueryClient,
  binding: Readonly<{ organizationId: string; deploymentKey: string }>,
): Promise<ActiveCatalogHeatManifest | null> {
  if (!isPrismaClient(database)) {
    return proveCurrentManifest(database, binding);
  }
  return database.$transaction(
    (transaction) => proveCurrentManifest(transaction, binding),
    {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
}
